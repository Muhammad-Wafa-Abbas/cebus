/**
 * OrchestratorLLM — thin abstraction over LangChain and Copilot SDK
 * so the orchestrator middleware can use either as its backing model.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AIRoutingConfig } from '../types.js';
import { OrchestrationError } from '../types.js';
import { createRoutingLLM } from './dynamic.js';
import { debug } from '../../core/debug-logger.js';

/** Minimal interface used by the orchestrator middleware (analyzer, evaluator, conversation). */
export interface OrchestratorLLM {
  invoke(systemPrompt: string, userMessage: string): Promise<string>;
  stream(systemPrompt: string, userMessage: string): AsyncIterable<string>;
  dispose(): Promise<void>;
}

/** Wraps a LangChain BaseChatModel behind the OrchestratorLLM interface. */
class LangChainOrchestratorLLM implements OrchestratorLLM {
  constructor(private readonly llm: BaseChatModel) {}

  async invoke(systemPrompt: string, userMessage: string): Promise<string> {
    const response = await this.llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userMessage),
    ]);
    return typeof response.content === 'string' ? response.content : '';
  }

  async *stream(systemPrompt: string, userMessage: string): AsyncIterable<string> {
    const stream = await this.llm.stream([
      new SystemMessage(systemPrompt),
      new HumanMessage(userMessage),
    ]);
    for await (const chunk of stream) {
      const token = typeof chunk.content === 'string' ? chunk.content : '';
      if (token) yield token;
    }
  }

  async dispose(): Promise<void> {
    // LangChain models don't need explicit cleanup
  }
}

/** Uses the Copilot SDK for orchestrator LLM calls (chat-only, no tools). */
class CopilotOrchestratorLLM implements OrchestratorLLM {
  private client: unknown = null;
  private session: unknown = null;

  constructor(private readonly model: string) {}

  async invoke(systemPrompt: string, userMessage: string): Promise<string> {
    const session = await this.getOrCreateSession();
    const typedSession = session as {
      on(handler: (event: { type: string; data: Record<string, unknown> }) => void): () => void;
      send(options: { prompt: string }): Promise<string>;
    };

    const prompt = `[System Instructions]\n${systemPrompt}\n\n[User Message]\n${userMessage}`;

    let fullContent = '';
    let resolved = false;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new OrchestrationError('TIMEOUT', 'Copilot orchestrator LLM timed out after 30s'));
        }
      }, 30000);

      const unsubscribe = typedSession.on((event) => {
        if (resolved) return;

        if (event.type === 'assistant.message_delta') {
          const delta = event.data['deltaContent'] as string | undefined;
          if (delta) fullContent += delta;
        }

        if (event.type === 'assistant.message') {
          const content = event.data['content'] as string | undefined;
          if (content) fullContent = content;
        }

        if (event.type === 'session.idle') {
          clearTimeout(timer);
          unsubscribe();
          if (!resolved) {
            resolved = true;
            resolve(fullContent);
          }
        }

        if (event.type === 'session.error') {
          clearTimeout(timer);
          unsubscribe();
          if (!resolved) {
            resolved = true;
            const errMsg = (event.data['message'] as string) ?? 'Unknown Copilot error';
            if (fullContent.length > 0) {
              resolve(fullContent);
            } else {
              reject(new OrchestrationError('WORKER_EXECUTION', `Copilot orchestrator LLM error: ${errMsg}`));
            }
          }
        }
      });

      typedSession.send({ prompt }).catch((err: unknown) => {
        clearTimeout(timer);
        unsubscribe();
        if (!resolved) {
          resolved = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async *stream(systemPrompt: string, userMessage: string): AsyncIterable<string> {
    const session = await this.getOrCreateSession();
    const typedSession = session as {
      on(handler: (event: { type: string; data: Record<string, unknown> }) => void): () => void;
      send(options: { prompt: string }): Promise<string>;
    };

    const prompt = `[System Instructions]\n${systemPrompt}\n\n[User Message]\n${userMessage}`;

    // Use a simple async queue pattern for streaming
    type QueueItem = { token: string } | { done: true } | { error: Error };
    const queue: QueueItem[] = [];
    let resolver: (() => void) | null = null;
    let streamDone = false;

    const push = (item: QueueItem): void => {
      queue.push(item);
      resolver?.();
    };

    const timer = setTimeout(() => {
      if (!streamDone) {
        streamDone = true;
        push({ error: new OrchestrationError('TIMEOUT', 'Copilot orchestrator LLM stream timed out after 30s') });
      }
    }, 30000);

    const unsubscribe = typedSession.on((event) => {
      if (streamDone) return;

      if (event.type === 'assistant.message_delta') {
        const delta = event.data['deltaContent'] as string | undefined;
        if (delta) push({ token: delta });
      }

      if (event.type === 'session.idle') {
        clearTimeout(timer);
        unsubscribe();
        streamDone = true;
        push({ done: true });
      }

      if (event.type === 'session.error') {
        clearTimeout(timer);
        unsubscribe();
        if (!streamDone) {
          streamDone = true;
          const errMsg = (event.data['message'] as string) ?? 'Unknown Copilot error';
          push({ error: new OrchestrationError('WORKER_EXECUTION', `Copilot orchestrator LLM stream error: ${errMsg}`) });
        }
      }
    });

    typedSession.send({ prompt }).catch((err: unknown) => {
      clearTimeout(timer);
      unsubscribe();
      if (!streamDone) {
        streamDone = true;
        push({ error: err instanceof Error ? err : new Error(String(err)) });
      }
    });

    // Yield tokens as they arrive
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((r) => { resolver = r; });
        resolver = null;
      }
      const item = queue.shift();
      if (!item) continue;
      if ('done' in item) return;
      if ('error' in item) throw item.error;
      yield item.token;
    }
  }

  async dispose(): Promise<void> {
    if (this.session) {
      try {
        await (this.session as { destroy(): Promise<void> }).destroy();
      } catch (error) {
        debug('orchestrator-llm', 'copilot-session-destroy-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.session = null;
    }
    if (this.client) {
      try {
        await (this.client as { close(): Promise<void> }).close();
      } catch (error) {
        debug('orchestrator-llm', 'copilot-client-close-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.client = null;
    }
  }

  private async getOrCreateSession(): Promise<unknown> {
    if (this.session) return this.session;

    const copilotSdk = await import('@github/copilot-sdk');
    const CopilotClient =
      (copilotSdk as Record<string, unknown>)['CopilotClient'] ??
      (copilotSdk as Record<string, unknown>)['default'];

    if (!CopilotClient) {
      throw new OrchestrationError(
        'WORKER_EXECUTION',
        'Failed to import CopilotClient from @github/copilot-sdk',
      );
    }

    this.client = new (CopilotClient as new () => Record<string, unknown>)();

    const createSession = (this.client as Record<string, unknown>)['createSession'] as
      ((config: Record<string, unknown>) => Promise<unknown>) | undefined;

    if (!createSession) {
      throw new OrchestrationError(
        'WORKER_EXECUTION',
        'CopilotClient.createSession is not available',
      );
    }

    this.session = await createSession.call(this.client, {
      model: this.model,
      streaming: true,
      // Chat-only — no tools for orchestrator duty
      availableTools: [],
    });

    debug('orchestrator-llm', 'copilot-session-created', { model: this.model });
    return this.session;
  }
}

/**
 * Create an OrchestratorLLM from the middleware config.
 * Supports all LangChain providers + Copilot SDK.
 */
export async function createOrchestratorLLM(
  config?: AIRoutingConfig,
): Promise<OrchestratorLLM> {
  const providerType = config?.provider?.type ?? 'ollama';

  if (providerType === 'copilot') {
    const model = config?.model ?? 'gpt-4o';
    return new CopilotOrchestratorLLM(model);
  }

  // All other providers use LangChain
  const baseChatModel = await createRoutingLLM(config);
  return new LangChainOrchestratorLLM(baseChatModel);
}
