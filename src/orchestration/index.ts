import { validateTeamConfig } from './config/loader.js';
import { compileGraph, OrchestrationGraphImpl } from './graph.js';
import type {
  TeamConfig,
  CompileOptions,
  OrchestrationGraph,
} from './types.js';

/**
 * Compile a team configuration into a runnable orchestration graph.
 *
 * This is the primary entry point for the orchestration module.
 *
 * @param config - TeamConfig object (will be validated)
 * @param options - Optional compile options (checkpointer, stream callback)
 * @returns A compiled OrchestrationGraph ready for invoke/stream
 */
export async function compile(
  config: TeamConfig | Record<string, unknown>,
  options?: CompileOptions & { agentToParticipant?: Map<string, string> },
): Promise<OrchestrationGraph> {
  const validatedConfig = validateTeamConfig(config);

  const { graph, workers, sessionManager, logger, streamCallbackRef, activeAbortControllers } = await compileGraph(
    validatedConfig,
    options,
    options?.agentToParticipant,
  );

  return new OrchestrationGraphImpl(
    graph,
    validatedConfig,
    workers,
    sessionManager,
    logger,
    options?.agentToParticipant,
    streamCallbackRef,
    activeAbortControllers,
  );
}

export type {
  OrchestrationMode,
  ConversationMode,
  MCPTransportType,
  CircuitState,
  SessionStatus,
  MCPServerConfig,
  ProviderConfig,
  CompactionConfig,
  PersistenceConfig,
  AIRoutingConfig,
  ToolApprovalConfig,
  BudgetConfig,
  AgentProfile,
  TeamConfig,
  OrchestratorMiddlewareConfig,
  OrchestratorAnalysis,
  OrchestratorPlan,
  OrchestratorPlanStep,
  AgentContribution,
  TaskCompletionSummary,
  RoutingDecision,
  MCPToolInvocation,
  CircuitBreakerState,
  ExecutionContext,
  TokenUsage,
  BudgetStatus,
  BudgetState,
  OrchestrationStreamEvent,
  StreamError,
  SessionRecord,
  SessionStartResult,
  CompileOptions,
  OrchestrationGraph,
  OrchestrationInput,
  ImageInput,
  InvokeOptions,
  OrchestrationOutput,
  AgentResponse,
  MCPInitResult,
  OrchestrationLogger,
  RoutingStrategy,
  RoutingState,
  RoutingResult,
  WorkerExecutor,
  OrchestrationErrorCode,
  PermissionKind,
  ApprovalResponse,
} from './types.js';

export { OrchestrationError } from './types.js';
export { loadTeamConfig, validateTeamConfig } from './config/loader.js';
export { getDefaultSystemPrompt, getModePrompt, getTierPrompt } from './config/defaults.js';

export { getOrCompileGraph, invalidateGraph, clearGraphCache } from './session/graph-cache.js';
export { buildSessionConfig, sanitizeAgentId, participantHash } from './session/config-builder.js';
export type { SessionConfigResult } from './session/config-builder.js';
export {
  createPlaceholder,
  appendToken,
  finalizeResponse,
  finalizeError,
} from './session/store-sync.js';
