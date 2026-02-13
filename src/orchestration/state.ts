/**
 * LangGraph State Schema
 *
 * T008: Defines the OrchestrationState using LangGraph Annotation.Root.
 * This is the central data structure flowing through graph nodes.
 */

import { Annotation, MessagesAnnotation } from '@langchain/langgraph';
import type {
  TeamConfig,
  RoutingDecision,
  ExecutionContext,
  OrchestratorAnalysis,
} from './types.js';

/**
 * OrchestrationState — the runtime state managed by LangGraph.
 *
 * Uses LangGraph's Annotation system for typed state with reducers:
 * - messages: append reducer (MessagesAnnotation)
 * - routingDecisions: append reducer
 * - All other fields: overwrite (last write wins)
 */
export const OrchestrationState = Annotation.Root({
  // Conversation messages — uses LangGraph's built-in message accumulation
  ...MessagesAnnotation.spec,

  // Team configuration — set at compile time, immutable during execution
  teamConfig: Annotation<TeamConfig>,

  // Sequential index tracking (-1 = nobody spoke yet, start from agent 0)
  lastSpeakerIndex: Annotation<number>({
    default: () => -1,
    reducer: (_prev, next) => next,
  }),

  // Trace ID for the current invocation
  currentTraceId: Annotation<string>({
    default: () => '',
    reducer: (_prev, next) => next,
  }),

  // Audit trail of routing decisions — appends
  routingDecisions: Annotation<RoutingDecision[]>({
    default: () => [],
    reducer: (prev, next) => [...prev, ...next],
  }),

  // Currently executing agent
  activeAgentId: Annotation<string | null>({
    default: () => null,
    reducer: (_prev, next) => next,
  }),

  // Agents pending execution (for sequential/multi-tag)
  pendingAgents: Annotation<string[]>({
    default: () => [],
    reducer: (_prev, next) => next,
  }),

  // Session identifier
  sessionId: Annotation<string>({
    default: () => '',
    reducer: (_prev, next) => next,
  }),

  // Whether the current invocation is complete
  isComplete: Annotation<boolean>({
    default: () => false,
    reducer: (_prev, next) => next,
  }),

  // System command detected (e.g., /reset, /help)
  systemCommand: Annotation<string | null>({
    default: () => null,
    reducer: (_prev, next) => next,
  }),

  // Execution contexts for pending agents
  executionContexts: Annotation<Record<string, ExecutionContext>>({
    default: () => ({}),
    reducer: (_prev, next) => next,
  }),

  // Directed routing override — when set, only these agent IDs respond
  directedTo: Annotation<string[]>({
    default: () => [],
    reducer: (_prev, next) => next,
  }),

  // Orchestrator middleware state
  orchestratorAnalysis: Annotation<OrchestratorAnalysis | null>({
    default: () => null,
    reducer: (_prev, next) => next,
  }),
  orchestratorRound: Annotation<number>({
    default: () => 0,
    reducer: (_prev, next) => next,
  }),
  orchestratorMaxRounds: Annotation<number>({
    default: () => 5,
    reducer: (_prev, next) => next,
  }),
  orchestratorPlanApproved: Annotation<boolean | null>({
    default: () => null,  // null = no plan, true = approved, false = rejected
    reducer: (_prev, next) => next,
  }),
});

export type OrchestrationStateType = typeof OrchestrationState.State;
