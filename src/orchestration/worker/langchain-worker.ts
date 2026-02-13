import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type {
  AgentProfile,
  AgentResponse,
  ExecutionContext,
  MCPInitResult,
  OrchestrationLogger,
  OrchestrationStreamEvent,
  WorkerExecutor,
} from '../types.js';
import { OrchestrationError } from '../types.js';

export class LangChainWorker implements WorkerExecutor {
  private chatModel: BaseChatModel | null = null;

  constructor(
    private readonly profile: AgentProfile,
    private readonly logger?: OrchestrationLogger,
  ) {}

  async execute(
    agentProfile: AgentProfile,
    message: string,
    conversationHistory: ReadonlyArray<{ role: string; content: string; name?: string | undefined }>,
    context: ExecutionContext,
    onStream: (event: OrchestrationStreamEvent) => void,
    traceId: string,
  ): Promise<AgentResponse> {
    const startTime = Date.now();
    this.logger?.workerStart(traceId, agentProfile.id);

    try {
      const model = await this.getOrCreateModel();

      const systemPrompt = this.buildSystemPrompt(agentProfile, context);

      // Build message list with proper attribution:
      // - User messages → HumanMessage
      // - THIS agent's own prior responses → AIMessage (model recognizes as its own)
      // - OTHER agents' responses → HumanMessage with [@Name] prefix
      //
      // IMPORTANT: We CANNOT use AIMessage with `name` field for other agents' responses.
      // Models ignore the `name` field and treat ALL AIMessage as their own prior output,
      // causing them to copy/repeat other models' answers verbatim.
      //
      // h.name is the agent's display name (e.g. "Claude claude-3-5-haiku-20241022"),
      // resolved from agentId by the graph worker node via config.agents.
      const myName = agentProfile.name;
      const messages = [
        new SystemMessage(systemPrompt),
        ...conversationHistory.map((h) => {
          if (h.role === 'user') {
            return new HumanMessage(h.content);
          }
          // This agent's own prior response — model sees it as "my previous answer"
          if (h.name === myName) {
            return new AIMessage(h.content);
          }
          // Another agent's response — must be HumanMessage so model doesn't think it said this
          const senderLabel = h.name ?? 'Another model';
          return new HumanMessage(`[${senderLabel}]: ${h.content}`);
        }),
        new HumanMessage(message),
      ];

      onStream({
        type: 'start',
        agentId: agentProfile.id,
        traceId,
        ...(context.orchestratorGuidance ? { guidance: context.orchestratorGuidance } : {}),
      });

      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;

      // Stream with timeout and cancellation
      const streamPromise = this.streamWithTimeout(
        model,
        messages,
        context,
        agentProfile.id,
        traceId,
        onStream,
      );

      const result = await streamPromise;
      fullContent = result.content;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;

      const tokenUsage = {
        inputTokens,
        outputTokens,
        ...(result.cacheReadTokens > 0 ? { cacheReadTokens: result.cacheReadTokens } : {}),
        ...(result.cacheWriteTokens > 0 ? { cacheWriteTokens: result.cacheWriteTokens } : {}),
      };

      const latencyMs = Date.now() - startTime;
      this.logger?.workerComplete(traceId, agentProfile.id, latencyMs);

      onStream({
        type: 'complete',
        agentId: agentProfile.id,
        traceId,
        content: fullContent,
        tokenUsage,
      });

      return {
        agentId: agentProfile.id,
        agentName: agentProfile.name,
        content: fullContent,
        toolInvocations: [],
        tokenUsage,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const errorMsg =
        err instanceof Error ? err.message : 'Unknown worker error';
      this.logger?.workerError(traceId, agentProfile.id, errorMsg);

      const errorCode = err instanceof OrchestrationError ? err.code : 'WORKER_EXECUTION';

      onStream({
        type: 'error',
        agentId: agentProfile.id,
        traceId,
        error: {
          code: errorCode,
          message: errorMsg,
          agentId: agentProfile.id,
          recoverable: errorCode !== 'CANCELLED',
        },
      });

      throw new OrchestrationError(
        errorCode,
        `Worker ${agentProfile.id} failed after ${latencyMs}ms: ${errorMsg}`,
        traceId,
        err instanceof Error ? err : undefined,
      );
    }
  }

  async initializeMCP(
    _agentProfile: AgentProfile,
  ): Promise<MCPInitResult> {
    // MCP integration handled in Phase 5 (T029-T036)
    return {
      serverId: 'none',
      status: 'connected',
      toolCount: 0,
    };
  }

  async dispose(): Promise<void> {
    this.chatModel = null;
  }

  /**
   * Get provider-specific stream options (e.g. Anthropic prompt caching headers).
   * Returns undefined when no special options are needed.
   */
  getStreamOptions(): Record<string, unknown> | undefined {
    const providerType = this.profile.provider?.type ?? 'openai';
    if (providerType === 'anthropic') {
      return {
        headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
      };
    }
    return undefined;
  }

  private async getOrCreateModel(): Promise<BaseChatModel> {
    if (this.chatModel) return this.chatModel;
    this.chatModel = await createChatModel(this.profile);
    return this.chatModel;
  }

  private buildSystemPrompt(
    agentProfile: AgentProfile,
    context: ExecutionContext,
  ): string {
    const parts = [
      `You are ${agentProfile.name}. ${agentProfile.role}`,
      '',
      'Instructions:',
      ...agentProfile.instructions.map((i) => `- ${i}`),
    ];

    // Inject orchestrator guidance if present
    if (context.orchestratorGuidance) {
      parts.push('', '## Orchestrator Instructions', context.orchestratorGuidance);
    }

    return parts.join('\n');
  }

  private async streamWithTimeout(
    model: BaseChatModel,
    messages: (HumanMessage | SystemMessage | AIMessage)[],
    context: ExecutionContext,
    agentId: string,
    traceId: string,
    onStream: (event: OrchestrationStreamEvent) => void,
  ): Promise<{ content: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> {
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new OrchestrationError(
            'TIMEOUT',
            `Worker ${agentId} exceeded timeout of ${context.timeoutBudget}ms`,
            traceId,
          ),
        );
      }, context.timeoutBudget);

      // Guard: cancellationToken may lose its prototype after state serialization
      const token = context.cancellationToken;
      if (token && typeof token.addEventListener === 'function') {
        token.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(
            new OrchestrationError(
              'CANCELLED',
              `Worker ${agentId} was cancelled`,
              traceId,
            ),
          );
        });
      }
    });

    const streamingPromise = (async (): Promise<{
      content: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }> => {
      const stream = await model.stream(messages);

      for await (const chunk of stream) {
        if (context.cancellationToken && 'aborted' in context.cancellationToken && context.cancellationToken.aborted) {
          throw new OrchestrationError(
            'CANCELLED',
            `Worker ${agentId} was cancelled during streaming`,
            traceId,
          );
        }

        const token =
          typeof chunk.content === 'string' ? chunk.content : '';
        if (token) {
          content += token;
          onStream({ type: 'token', agentId, traceId, token });
        }

        // Extract token usage from chunk metadata if available
        const usage = (chunk as unknown as Record<string, unknown>)['usage_metadata'] as
          | {
              input_tokens?: number;
              output_tokens?: number;
              input_token_details?: { cache_read?: number; cache_creation?: number };
            }
          | undefined;
        if (usage) {
          inputTokens = usage.input_tokens ?? inputTokens;
          outputTokens = usage.output_tokens ?? outputTokens;
          if (usage.input_token_details) {
            cacheReadTokens = usage.input_token_details.cache_read ?? cacheReadTokens;
            cacheWriteTokens = usage.input_token_details.cache_creation ?? cacheWriteTokens;
          }
        }
      }

      return { content, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
    })();

    try {
      return await Promise.race([streamingPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Factory: Create the appropriate LangChain chat model based on provider type.
 *
 * Follows Open/Closed Principle: Add new providers by adding a case.
 */
/** OpenAI model IDs that are NOT chat models and will fail with /v1/chat/completions. */
const NON_CHAT_KEYWORDS = [
  'deep-research', 'computer-use',
  'realtime', 'audio', 'dall-e', 'chatgpt-image', 'whisper', 'tts', 'embedding', 'moderation', 'search-preview',
  'babbage', 'davinci', 'curie', 'ada',
] as const;

const NON_CHAT_TYPE_LABELS: Record<string, string> = {
  'deep-research': 'deep research (Responses API only)',
  'computer-use': 'computer use (Responses API only)',
  realtime: 'realtime audio/voice',
  audio: 'audio input/output',
  'dall-e': 'image generation',
  'chatgpt-image': 'image generation',
  'search-preview': 'experimental search (incompatible parameters)',
  whisper: 'audio transcription',
  tts: 'text-to-speech',
  embedding: 'embedding',
  moderation: 'content moderation',
  babbage: 'legacy completions',
  davinci: 'legacy completions',
  curie: 'legacy completions',
  ada: 'legacy completions',
};

async function createChatModel(profile: AgentProfile): Promise<BaseChatModel> {
  const providerType = profile.provider?.type ?? 'openai';
  const model = profile.model;
  const apiKey = profile.provider?.apiKey;
  const baseUrl = profile.provider?.baseUrl;

  // Validate OpenAI model is a chat model (not realtime, embedding, etc.)
  if (providerType === 'openai' && model) {
    const matched = NON_CHAT_KEYWORDS.find(kw => model.toLowerCase().includes(kw));
    if (matched) {
      const typeLabel = NON_CHAT_TYPE_LABELS[matched] ?? matched;
      throw new OrchestrationError(
        'CONFIG_VALIDATION',
        `Model "${model}" is a ${typeLabel} model and cannot be used as a chat model. Use a chat-compatible model like gpt-4o or gpt-4o-mini instead.`,
      );
    }
  }

  switch (providerType) {
    case 'openai': {
      const { ChatOpenAI } = await import('@langchain/openai');
      const openaiKey = apiKey ?? process.env['OPENAI_API_KEY'];
      return new ChatOpenAI({
        ...(model !== undefined ? { model } : {}),
        ...(openaiKey !== undefined ? { apiKey: openaiKey } : {}),
        ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
      });
    }

    case 'anthropic': {
      const { ChatAnthropic } = await import('@langchain/anthropic');
      const anthropicKey = apiKey ?? process.env['ANTHROPIC_API_KEY'];
      return new ChatAnthropic({
        ...(model !== undefined ? { model } : {}),
        ...(anthropicKey !== undefined ? { apiKey: anthropicKey } : {}),
      });
    }

    case 'gemini': {
      const { ChatGoogleGenerativeAI } = await import(
        '@langchain/google-genai'
      );
      const geminiKey = apiKey ?? process.env['GOOGLE_API_KEY'];
      return new ChatGoogleGenerativeAI({
        model: model ?? 'gemini-2.0-flash',
        ...(geminiKey !== undefined ? { apiKey: geminiKey } : {}),
      });
    }

    case 'ollama': {
      const { ChatOllama } = await import('@langchain/ollama');
      return new ChatOllama({
        ...(model !== undefined ? { model } : {}),
        baseUrl: baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
      });
    }

    default:
      throw new OrchestrationError(
        'CONFIG_VALIDATION',
        `Unsupported provider for LangChain worker: ${providerType}`,
      );
  }
}
