/**
 * Shared types for stream event handlers.
 */

import type { Participant, Message } from '../../../core/types';
import type { OrchestrationGraph } from '../../../orchestration/types.js';
import type { StaticEntry, StreamFlushBuffer, OrchestratorMessage, PendingToolApproval, PendingPlanApproval, PlanProgress, AgentActivityEntry } from '../../chat-types';

/** Context shared by all stream event handlers. */
export interface StreamHandlerContext {
  sessionId: string;
  participants: Participant[];
  idMap: ReadonlyMap<string, string>;
  placeholders: Map<string, { id: string; senderId: string }>;
  startedAgents: Set<string>;
  streamFlushRef: React.MutableRefObject<Map<string, StreamFlushBuffer>>;
  streamingMessageIds: React.MutableRefObject<Set<string>>;
  streamingOrder: React.MutableRefObject<string[]>;
  guidanceRef: React.MutableRefObject<Map<string, string>>;
  staticIds: React.MutableRefObject<Set<string>>;
  modelResponseCount: React.MutableRefObject<number>;
  graphRef: React.MutableRefObject<OrchestrationGraph | null>;
  latestAnalysisRef: React.MutableRefObject<import('../../../orchestration/types.js').OrchestratorAnalysis | null>;

  setStaticEntries: React.Dispatch<React.SetStateAction<StaticEntry[]>>;
  setStreamingParticipants: React.Dispatch<React.SetStateAction<string[]>>;
  setWaitingParticipants: React.Dispatch<React.SetStateAction<string[]>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setOrchestratorMessages: React.Dispatch<React.SetStateAction<OrchestratorMessage[]>>;
  setPendingToolApproval: React.Dispatch<React.SetStateAction<PendingToolApproval | null>>;
  setPendingPlanApproval: React.Dispatch<React.SetStateAction<PendingPlanApproval | null>>;
  setPlanProgress: React.Dispatch<React.SetStateAction<PlanProgress | null>>;
  setCompactionNotice: React.Dispatch<React.SetStateAction<string | null>>;
  setAgentActivity: React.Dispatch<React.SetStateAction<Map<string, AgentActivityEntry[]>>>;

  markAgentStarted: (agentId: string, participantId: string) => void;
}
