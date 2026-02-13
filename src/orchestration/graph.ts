
import { StateGraph, START, END, Send, type BaseCheckpointSaver } from '@langchain/langgraph';
import { HumanMessage, AIMessage, trimMessages } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { OrchestrationState } from './state.js';
import type { OrchestrationStateType } from './state.js';
import { createOrchestratorNode } from './orchestrator/index.js';
import { createAnalyzerNode, createEvaluatorNode } from './orchestrator/middleware.js';
import { createWorker } from './worker/factory.js';
import { SessionManager } from './session/manager.js';
import { StructuredLogger } from './observability/logger.js';
import { generateTraceId } from './observability/tracer.js';
import type {
  TeamConfig,
  CompileOptions,
  OrchestrationGraph,
  OrchestrationInput,
  InvokeOptions,
  OrchestrationOutput,
  OrchestrationStreamEvent,
  ExecutionContext,
  AgentResponse,
  SessionStartResult,
  CircuitBreakerState,
  BudgetStatus,
  WorkerExecutor,
  OrchestrationLogger,
  ConversationHistoryEntry,
} from './types.js';
import { OrchestrationError } from './types.js';
import type { CopilotWorker } from './worker/copilot-worker.js';
import { getModelTier, getTierTokenBudget, estimateTokens } from '../core/model-tiers.js';
import { getParticipant } from '../core/session.js';
import { compactMessages } from './session/compaction.js';

interface StreamCallbackRef {
  current: ((event: OrchestrationStreamEvent) => void) | undefined;
}

interface CompileResult {
  graph: CompiledGraph;
  workers: Map<string, WorkerExecutor>;
  sessionManager: SessionManager;
  logger: OrchestrationLogger;
  /** Mutable ref container for the stream callback, shared with the graph impl */
  streamCallbackRef: StreamCallbackRef;
  /** Shared map of active AbortControllers keyed by agentId — enables cancel-from-UI */
  activeAbortControllers: Map<string, AbortController>;
}

/**
 * LangGraph SDK does not export the CompiledGraph type from `@langchain/langgraph`.
 * The compiled graph returned by `StateGraph.compile()` is typed as a complex generic
 * that cannot be referenced without `any`. This alias keeps the workaround localized.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompiledGraph = any;

/**
 * Compile a validated TeamConfig into a runnable LangGraph.
 */
export async function compileGraph(
  config: TeamConfig,
  options?: CompileOptions,
  agentToParticipant?: ReadonlyMap<string, string>,
): Promise<CompileResult> {
  const logger = new StructuredLogger(process.env['DEBUG'] === 'true');
  const sessionManager = new SessionManager(config);

  const streamCallbackRef: StreamCallbackRef = {
    current: options?.onStream,
  };

  const workers = new Map<string, WorkerExecutor>();
  for (const agent of config.agents) {
    const worker = await createWorker(agent, logger);
    workers.set(agent.id, worker);
  }

  const activeAbortControllers = new Map<string, AbortController>();

  const orchestratorFn = createOrchestratorNode(config, logger, activeAbortControllers);
  const graphBuilder = new StateGraph(OrchestrationState);

  graphBuilder.addNode('orchestrator', async (state: OrchestrationStateType) => {
    const traceId = state.currentTraceId || generateTraceId();

    const result = await orchestratorFn(state, traceId);

    // If directedTo is set, override routing — only those agents respond
    let targetAgentIds = result.targetAgentIds;
    let executionContexts = result.executionContexts;
    if (state.directedTo.length > 0) {
      targetAgentIds = state.directedTo.filter((id) =>
        config.agents.some((a) => a.id === id),
      );
      const DEFAULT_TIMEOUT = 60000;
      const directedContexts: Record<string, ExecutionContext> = {};
      for (const agentId of targetAgentIds) {
        if (executionContexts[agentId]) {
          directedContexts[agentId] = executionContexts[agentId];
        } else {
          const controller = new AbortController();
          activeAbortControllers.set(agentId, controller);
          directedContexts[agentId] = {
            activeAgentId: agentId,
            allowedTools: ['*'],
            routingReason: 'Directed via @mention',
            timeoutBudget: DEFAULT_TIMEOUT,
            cancellationToken: controller.signal,
          };
        }
      }
      executionContexts = directedContexts;
    }

    return {
      routingDecisions: [result.routingDecision],
      activeAgentId: targetAgentIds[0] ?? null,
      pendingAgents: targetAgentIds.slice(1),
      systemCommand: result.systemCommand,
      lastSpeakerIndex: result.lastSpeakerIndex,
      executionContexts,
      isComplete:
        result.systemCommand !== null ||
        targetAgentIds.length === 0,
    };
  });

  graphBuilder.addNode('worker', async (state: OrchestrationStateType) => {
    const agentId = state.activeAgentId;
    if (!agentId) {
      return { isComplete: true };
    }

    const worker = workers.get(agentId);
    if (!worker) {
      return { isComplete: true };
    }

    const agentProfile = config.agents.find((a) => a.id === agentId);
    if (!agentProfile) {
      return { isComplete: true };
    }

    const traceId = state.currentTraceId || generateTraceId();
    const executionContext = state.executionContexts[agentId];

    if (!executionContext) {
      return { isComplete: true };
    }

    const lastHumanMessage = [...state.messages]
      .reverse()
      .find((m) => m._getType() === 'human');
    const messageContent =
      typeof lastHumanMessage?.content === 'string' && lastHumanMessage.content.length > 0
        ? lastHumanMessage.content
        : 'Hello';

    const agentNameMap = new Map(config.agents.map((a) => [a.id, a.name]));

    const filteredMessages = state.messages.filter(
      (m) =>
        m !== lastHumanMessage &&
        (m._getType() === 'human' || m._getType() === 'ai'),
    );

    const onStream: (event: OrchestrationStreamEvent) => void =
      streamCallbackRef.current ??
      (() => {});

    const isCopilot = agentProfile.provider?.type === 'copilot';

    // Determine windowing mode:
    // - Copilot: skip all windowing/compaction (SDK has built-in Infinite Sessions)
    // - maxHistoryMessages set → message-count mode (backwards compat)
    // - Otherwise → token-budget mode via trimMessages
    let history: { role: string; content: string; name: string | undefined }[];

    if (isCopilot) {
      // Copilot path: SDK handles compaction natively — pass all messages through
      history = filteredMessages
        .map((m) => ({
          role: m._getType() === 'human' ? 'user' : 'assistant',
          content: typeof m.content === 'string' ? m.content : '',
          name: m._getType() === 'ai'
            ? (agentNameMap.get((m as AIMessage).name ?? '') ?? (m as AIMessage).name ?? undefined)
            : undefined,
        }))
        .filter((m) => m.content.length > 0);

      // Informational event — no actual compaction performed
      onStream({
        type: 'compaction_status',
        traceId,
        agentId,
        agentName: agentProfile.name,
        source: 'sdk',
        totalMessages: filteredMessages.length,
        windowSize: filteredMessages.length,
        compactedMessages: 0,
        summarized: false,
      });
    } else {
      // LangChain path
      const useMessageMode = config.compaction?.maxHistoryMessages !== undefined;

      let keptMessages: typeof filteredMessages;
      let overflowMessages: typeof filteredMessages;
      let windowSize: number;
      let totalTokens: number | undefined;
      let tokenBudget: number | undefined;
      let windowTokens: number | undefined;

      if (useMessageMode) {
        // Message-count mode (original behavior)
        const historyWindow = config.compaction!.maxHistoryMessages!;
        windowSize = historyWindow;
        if (filteredMessages.length > historyWindow) {
          overflowMessages = filteredMessages.slice(0, filteredMessages.length - historyWindow);
          keptMessages = filteredMessages.slice(-historyWindow);
        } else {
          overflowMessages = [];
          keptMessages = filteredMessages;
        }
      } else {
        // Token-budget mode via trimMessages
        const tier = getModelTier(agentProfile.model ?? '');
        const budget = config.compaction?.maxHistoryTokens ?? getTierTokenBudget(tier);
        tokenBudget = budget;

        const trimmed = await trimMessages(filteredMessages, {
          maxTokens: budget,
          tokenCounter: (msgs) => msgs.reduce((acc, m) => {
            const content = typeof m.content === 'string' ? m.content : '';
            return acc + estimateTokens(content);
          }, 0),
          strategy: 'last',
        });

        keptMessages = trimmed as typeof filteredMessages;
        overflowMessages = filteredMessages.slice(0, filteredMessages.length - keptMessages.length);
        windowSize = keptMessages.length;

        // Compute token stats
        windowTokens = keptMessages.reduce((acc, m) => {
          const content = typeof m.content === 'string' ? m.content : '';
          return acc + estimateTokens(content);
        }, 0);
        totalTokens = filteredMessages.reduce((acc, m) => {
          const content = typeof m.content === 'string' ? m.content : '';
          return acc + estimateTokens(content);
        }, 0);
      }

      // Compaction: if enabled and there are overflow messages, summarize them
      let compactionSummary: string | undefined;
      if (
        config.compaction?.enabled &&
        overflowMessages.length > 0
      ) {
        const overflowTexts = overflowMessages.map((m) => {
          const role = m._getType() === 'human' ? 'user' : 'assistant';
          const name = m._getType() === 'ai'
            ? (agentNameMap.get((m as AIMessage).name ?? '') ?? (m as AIMessage).name ?? undefined)
            : undefined;
          const content = typeof m.content === 'string' ? m.content : '';
          return name ? `[${name}] (${role}): ${content}` : `(${role}): ${content}`;
        }).filter((t) => t.length > 5);

        if (overflowTexts.length > 0) {
          compactionSummary = await compactMessages(
            overflowTexts,
            config.compaction.summaryModel,
            config.compaction.summaryProvider,
          );
        }
      }

      history = keptMessages
        .map((m) => ({
          role: m._getType() === 'human' ? 'user' : 'assistant',
          content: typeof m.content === 'string' ? m.content : '',
          name: m._getType() === 'ai'
            ? (agentNameMap.get((m as AIMessage).name ?? '') ?? (m as AIMessage).name ?? undefined)
            : undefined,
        }))
        .filter((m) => m.content.length > 0);

      // Prepend compaction summary as a context entry if available
      if (compactionSummary) {
        history.unshift({
          role: 'user',
          content: `[Previous conversation summary]\n${compactionSummary}`,
          name: undefined,
        });
      }

      // Emit compaction status so the UI can show progress toward compaction
      onStream({
        type: 'compaction_status',
        traceId,
        agentId,
        agentName: agentProfile.name,
        source: 'custom',
        totalMessages: filteredMessages.length,
        windowSize,
        compactedMessages: overflowMessages.length,
        summarized: compactionSummary !== undefined,
        totalTokens,
        tokenBudget,
        windowTokens,
      });
    }

    const nextAgent = state.pendingAgents[0] ?? null;
    const remainingAgents = state.pendingAgents.slice(1);

    try {
      const response = await worker.execute(
        agentProfile,
        messageContent,
        history,
        executionContext,
        onStream,
        traceId,
      );

      activeAbortControllers.delete(agentId);

      // Persist Copilot SDK sessionId for zero-cost resume on next session restore
      if (isCopilot && agentToParticipant) {
        const copilotWorker = worker as unknown as CopilotWorker;
        const copilotSid = copilotWorker.getSessionId();
        const participantId = agentToParticipant.get(agentId);
        if (copilotSid && participantId) {
          const participant = getParticipant(state.sessionId, participantId);
          if (participant) {
            participant.providerSessionState = {
              sessionId: copilotSid,
              modelId: agentProfile.model ?? '',
              createdAt: participant.providerSessionState?.createdAt ?? new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              lastProcessedMessageIndex: 0,
              contextInitialized: true,
            };
          }
        }
      }

      const aiMessage = new AIMessage({
        content: response.content,
        name: agentId,
      });

      return {
        messages: [aiMessage],
        activeAgentId: nextAgent,
        pendingAgents: remainingAgents,
        isComplete: nextAgent === null,
      };
    } catch (err) {
      activeAbortControllers.delete(agentId);

      const errorCode = err instanceof OrchestrationError ? err.code : 'WORKER_EXECUTION';
      const errorMsg = err instanceof Error ? err.message : 'Unknown worker error';
      logger.workerError(traceId, agentId, errorMsg);

      onStream({
        type: 'error',
        agentId,
        traceId,
        error: {
          code: errorCode,
          message: errorMsg,
          agentId,
          recoverable: errorCode !== 'CANCELLED',
        },
      });

      return {
        activeAgentId: nextAgent,
        pendingAgents: remainingAgents,
        isComplete: nextAgent === null,
      };
    }
  });

  const hasOrchestrator = config.orchestrator !== undefined;

  if (hasOrchestrator) {
    const analyzerFn = createAnalyzerNode(config, streamCallbackRef, activeAbortControllers);
    const evaluatorFn = createEvaluatorNode(config, streamCallbackRef, activeAbortControllers);

    graphBuilder.addNode('orchestrator_analyzer', async (state: OrchestrationStateType) => {
      return await analyzerFn(state);
    });

    graphBuilder.addNode('orchestrator_evaluator', async (state: OrchestrationStateType) => {
      return await evaluatorFn(state);
    });

    graphBuilder.addEdge(START, 'orchestrator_analyzer' as '__start__');

    graphBuilder.addConditionalEdges(
      'orchestrator_analyzer' as '__start__',
      (state: OrchestrationStateType) => {
        if (state.isComplete) return END;
        if (state.systemCommand === 'await_approval') return END;
        if (state.activeAgentId || state.orchestratorAnalysis?.selectedAgents?.length) {
          return 'orchestrator';
        }
        return 'orchestrator';
      },
    );

    graphBuilder.addConditionalEdges(
      'orchestrator' as '__start__',
      (state: OrchestrationStateType) => {
        if (state.isComplete) return END;
        if (!state.activeAgentId) return END;

        if (config.conversationMode === 'free_chat') {
          const allAgents = [state.activeAgentId, ...state.pendingAgents];
          return allAgents.map(
            agentId =>
              new Send('worker', {
                ...state,
                activeAgentId: agentId,
                pendingAgents: [],
                isComplete: false,
              }),
          );
        }

        return 'worker';
      },
    );

    // worker → orchestrator_evaluator (instead of looping directly)
    graphBuilder.addConditionalEdges(
      'worker' as '__start__',
      (state: OrchestrationStateType) => {
        // If there are pending agents from the routing strategy, continue to next worker
        if (state.activeAgentId && !state.isComplete) return 'worker';
        // No more pending — evaluate the round
        return 'orchestrator_evaluator';
      },
    );

    // evaluator → worker (next round) or END
    graphBuilder.addConditionalEdges(
      'orchestrator_evaluator' as '__start__',
      (state: OrchestrationStateType) => {
        if (state.isComplete) return END;
        if (state.activeAgentId) return 'worker';
        return END;
      },
    );
  } else {
    // No orchestrator middleware — original flow

    // Wire edges: START → orchestrator
    graphBuilder.addEdge(START, 'orchestrator' as '__start__');

    // Conditional edge from orchestrator
    graphBuilder.addConditionalEdges(
      'orchestrator' as '__start__',
      (state: OrchestrationStateType) => {
        if (state.isComplete) return END;
        if (!state.activeAgentId) return END;

        if (config.conversationMode === 'free_chat') {
          const allAgents = [state.activeAgentId, ...state.pendingAgents];
          return allAgents.map(
            agentId =>
              new Send('worker', {
                ...state,
                activeAgentId: agentId,
                pendingAgents: [],
                isComplete: false,
              }),
          );
        }

        return 'worker';
      },
    );

    // Conditional edge from worker — loop back for pending agents
    graphBuilder.addConditionalEdges(
      'worker' as '__start__',
      (state: OrchestrationStateType) => {
        if (state.activeAgentId && !state.isComplete) return 'worker';
        return END;
      },
    );
  }

  // Compile
  const checkpointer = options?.checkpointer as BaseCheckpointSaver | undefined;
  const compiledGraph = graphBuilder.compile(checkpointer ? { checkpointer } : {});

  return {
    graph: compiledGraph,
    workers,
    sessionManager,
    logger,
    streamCallbackRef,
    activeAbortControllers,
  };
}

/**
 * Convert prior conversation history entries into LangChain messages
 * for seeding the graph state (e.g. resumed sessions).
 */
function buildHistoryMessages(
  history: readonly ConversationHistoryEntry[] | undefined,
): (HumanMessage | AIMessage)[] {
  if (!history || history.length === 0) return [];

  return history.map((entry) => {
    if (entry.role === 'user') {
      return new HumanMessage(entry.content);
    }
    if (entry.name) {
      return new AIMessage({ content: entry.content, name: entry.name });
    }
    return new AIMessage(entry.content);
  });
}

export class OrchestrationGraphImpl implements OrchestrationGraph {
  public readonly agentToParticipant: ReadonlyMap<string, string>;

  /** Shared ref for overriding the stream callback at runtime */
  private readonly streamCallbackRef: StreamCallbackRef;

  /** Shared map of active AbortControllers keyed by agentId */
  private readonly activeAbortControllers: Map<string, AbortController>;

  constructor(
    private readonly graph: CompiledGraph,
    private readonly config: TeamConfig,
    private readonly workers: Map<string, WorkerExecutor>,
    private readonly sessionManager: SessionManager,
    private readonly logger: OrchestrationLogger,
    agentToParticipant?: ReadonlyMap<string, string>,
    streamCallbackRef?: StreamCallbackRef,
    activeAbortControllers?: Map<string, AbortController>,
  ) {
    this.agentToParticipant = agentToParticipant ?? new Map();
    this.streamCallbackRef = streamCallbackRef ?? { current: undefined };
    this.activeAbortControllers = activeAbortControllers ?? new Map();
  }

  cancelAgent(agentId: string): void {
    const controller = this.activeAbortControllers.get(agentId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(agentId);
    }
  }

  cancelAll(): string[] {
    const cancelled: string[] = [];
    for (const [agentId, controller] of this.activeAbortControllers) {
      controller.abort();
      cancelled.push(agentId);
    }
    this.activeAbortControllers.clear();
    return cancelled;
  }

  async invoke(
    input: OrchestrationInput,
    options?: InvokeOptions,
  ): Promise<OrchestrationOutput> {
    const traceId = input.traceId ?? generateTraceId();

    const graphInput: Record<string, unknown> = {
      messages: [
        ...buildHistoryMessages(input.conversationHistory),
        new HumanMessage(input.message),
      ],
      currentTraceId: traceId,
      sessionId: input.sessionId,
      directedTo: input.directedTo ?? [],
      // Reset transient state so stale checkpoint values don't short-circuit
      isComplete: false,
      activeAgentId: null,
      pendingAgents: [],
      executionContexts: {},
      systemCommand: null,
      // Orchestrator state: preserve approved analysis if provided, otherwise reset
      orchestratorAnalysis: input.approvedAnalysis ?? null,
      orchestratorRound: 0,
      orchestratorPlanApproved: input.approvedAnalysis ? true : null,
    };

    const graphConfig: RunnableConfig = {
      configurable: { thread_id: input.threadId ?? input.sessionId },
    };

    if (options?.signal) {
      graphConfig.signal = options.signal;
    }

    // Run the graph
    const result = await (this.graph as { invoke: (input: Record<string, unknown>, config: RunnableConfig) => Promise<Record<string, unknown>> }).invoke(graphInput, graphConfig);
    const state = result as unknown as OrchestrationStateType;

    // Extract routing decision
    const decisions = state.routingDecisions;
    const routingDecision = decisions[decisions.length - 1];

    if (!routingDecision) {
      throw new OrchestrationError(
        'ROUTING_FAILURE',
        'No routing decision was made',
        traceId,
      );
    }

    // Extract agent responses from AI messages
    const responses: AgentResponse[] = [];
    const aiMessages = state.messages.filter(
      (m) => m._getType() === 'ai' && m.name,
    );

    for (const msg of aiMessages) {
      const agentLabel = msg.name ?? '';
      const agentProfile = this.config.agents.find(
        (a) => a.id === agentLabel || a.name === agentLabel,
      );
      if (agentProfile) {
        responses.push({
          agentId: agentProfile.id,
          agentName: agentProfile.name,
          content: typeof msg.content === 'string' ? msg.content : '',
          toolInvocations: [],
        });
      }
    }

    // Update session message count
    this.sessionManager.updateMessageCount(
      input.sessionId,
      state.messages.length,
    );

    return {
      responses,
      routingDecision,
      traceId,
    };
  }

  async *stream(
    input: OrchestrationInput,
    options?: InvokeOptions,
  ): AsyncIterable<OrchestrationStreamEvent> {
    const traceId = input.traceId ?? generateTraceId();

    const graphInput: Record<string, unknown> = {
      messages: [
        ...buildHistoryMessages(input.conversationHistory),
        new HumanMessage(input.message),
      ],
      currentTraceId: traceId,
      sessionId: input.sessionId,
      directedTo: input.directedTo ?? [],
      // Reset transient state so stale checkpoint values don't short-circuit
      isComplete: false,
      activeAgentId: null,
      pendingAgents: [],
      executionContexts: {},
      systemCommand: null,
      // Orchestrator state: preserve approved analysis if provided, otherwise reset
      orchestratorAnalysis: input.approvedAnalysis ?? null,
      orchestratorRound: 0,
      orchestratorPlanApproved: input.approvedAnalysis ? true : null,
    };

    const graphConfig: RunnableConfig = {
      configurable: { thread_id: input.threadId ?? input.sessionId },
    };

    if (options?.signal) {
      graphConfig.signal = options.signal;
    }

    // Use a queue to collect events from workers
    const eventQueue: OrchestrationStreamEvent[] = [];
    let resolveWaiter: (() => void) | undefined;
    let done = false;

    // Set up the stream callback that pushes events into the queue
    const pushToQueue = (event: OrchestrationStreamEvent): void => {
      eventQueue.push(event);
      if (resolveWaiter) {
        const waiter = resolveWaiter;
        resolveWaiter = undefined;
        waiter();
      }
    };

    // Temporarily set the shared stream callback ref so workers push to the queue
    const prevCallback = this.streamCallbackRef.current;
    this.streamCallbackRef.current = pushToQueue;

    // Run graph in background, collecting stream events
    const graphPromise = (async (): Promise<void> => {
      try {
        const streamIterator = await (this.graph as { stream: (input: Record<string, unknown>, config: RunnableConfig) => Promise<AsyncIterable<unknown>> }).stream(
          graphInput,
          graphConfig,
        );

        for await (const _chunk of streamIterator) {
          // State updates flow through — events are pushed to queue via pushToQueue
        }
      } finally {
        this.streamCallbackRef.current = prevCallback;
        done = true;
        if (resolveWaiter) {
          const waiter = resolveWaiter;
          resolveWaiter = undefined;
          waiter();
        }
      }
    })();

    // Yield events as they arrive
    while (!done || eventQueue.length > 0) {
      if (eventQueue.length > 0) {
        const event = eventQueue.shift();
        if (event) yield event;
      } else if (!done) {
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
        });
      }
    }

    await graphPromise;

    yield { type: 'session_end', traceId, sessionId: input.sessionId };
  }

  async startSession(): Promise<SessionStartResult> {
    const result = this.sessionManager.startSession();
    this.logger.sessionStart(result.sessionId, result.teamId);
    return result;
  }

  async endSession(sessionId: string): Promise<void> {
    // Dispose all workers
    for (const worker of this.workers.values()) {
      await worker.dispose();
    }

    await this.sessionManager.endSession(sessionId);
    this.logger.sessionEnd(sessionId);
  }

  async resumeSession(sessionId: string): Promise<SessionStartResult> {
    return this.sessionManager.resumeSession(sessionId);
  }

  async getMCPHealth(): Promise<Record<string, CircuitBreakerState>> {
    // MCP health — implemented in Phase 5
    return {};
  }

  async getBudgetStatus(sessionId: string): Promise<BudgetStatus> {
    // Budget status — implemented in Phase 5b
    return {
      sessionId,
      agentUsage: {},
      totalTokens: 0,
      limits: {
        perAgentPerSession: this.config.budgets?.maxTokensPerAgentPerSession ?? null,
        perSession: this.config.budgets?.maxTokensPerSession ?? null,
        perMinute: this.config.budgets?.maxInvocationsPerMinute ?? null,
      },
    };
  }

  async respondToApproval(
    approvalId: string,
    approved: boolean,
    budget?: number,
  ): Promise<void> {
    // Parse agentId from approvalId format: "{agentId}-perm-{N}"
    const permIndex = approvalId.lastIndexOf('-perm-');
    if (permIndex === -1) {
      throw new OrchestrationError(
        'WORKER_EXECUTION',
        `Invalid approvalId format: ${approvalId}`,
      );
    }
    const agentId = approvalId.slice(0, permIndex);

    const worker = this.workers.get(agentId);
    if (!worker) {
      throw new OrchestrationError(
        'WORKER_EXECUTION',
        `Worker not found for agentId: ${agentId}`,
      );
    }

    // CopilotWorker has a resolveApproval method
    const copilotWorker = worker as unknown as CopilotWorker;
    if (typeof copilotWorker.resolveApproval !== 'function') {
      throw new OrchestrationError(
        'WORKER_EXECUTION',
        `Worker ${agentId} does not support approval resolution`,
      );
    }

    const response = { approved, budget: budget ?? (approved ? 1 : 0) };
    copilotWorker.resolveApproval(approvalId, response);

    // Emit approval_result event
    const onStream = this.streamCallbackRef.current;
    if (onStream) {
      onStream({
        type: 'approval_result',
        traceId: '',
        approvalId,
        approved,
      });
    }
  }
}
