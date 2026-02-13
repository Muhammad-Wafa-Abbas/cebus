import type { Message } from '../core/types';
import type { PermissionKind, OrchestratorPlan, TaskCompletionSummary } from '../orchestration/types.js';

/** URL confirmation pending state. */
export interface PendingUrlConfirmation {
  content: string;
  directedTo?: string[];
  urls: string[];
}

/** MCP tool approval pending state. */
export interface PendingToolApproval {
  approvalId: string;
  agentName: string;
  permissionKind: PermissionKind;
  toolName: string;
  parameters: Record<string, unknown>;
}

/** Orchestrator message with type info for differentiated rendering. */
export interface OrchestratorMessage {
  kind: 'analysis' | 'direct' | 'round' | 'complete' | 'plan' | 'status';
  content: string;
  timestamp: Date;
  taskSummary?: TaskCompletionSummary | undefined;
}

/** Static items rendered into the terminal scroll buffer (Ink's Static component). */
export type StaticEntry =
  | { id: string; kind: 'message'; message: Message }
  | { id: string; kind: 'stream-header'; senderId: string; guidance?: string | undefined }
  | { id: string; kind: 'stream-text'; content: string }
  | { id: string; kind: 'plan'; plan: OrchestratorPlan; approved: boolean };

/** Per-participant streaming flush buffer. */
export interface StreamFlushBuffer {
  messageId: string;
  unflushed: string;
  chunkCounter: number;
  headerEmitted: boolean;
  inCodeBlock: boolean;
  codeBlockAccum: string;
}

/** Orchestrator plan pending approval. */
export interface PendingPlanApproval {
  plan: OrchestratorPlan;
  analysis: import('../orchestration/types.js').OrchestratorAnalysis;
  originalMessage: string;
}

/** Plan execution progress. */
export interface PlanProgress {
  plan: OrchestratorPlan;
  completed: number;
  activeAgent: string | null;
}

/** A single activity entry for an agent (tool use with optional result). */
export interface AgentActivityEntry {
  activity: string;
  result?: string | undefined;
}

export type AppView = 'chat' | 'help' | 'participants';
