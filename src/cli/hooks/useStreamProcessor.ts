import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message, Participant } from '../../core/types';
import {
  getMessages,
  addMessage,
  updateMessage,
} from '../../core/session';
import { createUserMessage, markMessageSent } from '../../core/message';
import { parseMentions } from '../../core/mention-parser';
import { getOrCompileGraph } from '../../orchestration/session/graph-cache.js';
import { createPlaceholder } from '../../orchestration/session/store-sync.js';
import type {
  OrchestrationStreamEvent,
  ConversationHistoryEntry,
  OrchestrationGraph,
  OrchestratorAnalysis,
} from '../../orchestration/types.js';
import { logMessage, logChatMessage } from '../../core/debug-logger';
import { detectUrls } from '../../core/web-fetch';
import type {
  PendingUrlConfirmation,
  PendingToolApproval,
  OrchestratorMessage,
  StaticEntry,
  StreamFlushBuffer,
  PendingPlanApproval,
  PlanProgress,
  AgentActivityEntry,
} from '../chat-types';

import {
  handleTokenEvent,
  handleStartEvent,
  handleCompleteEvent,
  handleErrorEvent,
  handleOrchestratorAnalysis,
  handleOrchestratorPlan,
  handleOrchestratorRound,
  handleOrchestratorDirect,
  handleOrchestratorComplete,
  handleApprovalRequired,
  handleApprovalResult,
  handleCompactionStatus,
  handleAgentActivity,
  type StreamHandlerContext,
} from './handlers';

interface UseStreamProcessorParams {
  sessionId: string;
  participants: Participant[];
  resumeMode: 'full' | 'summary' | 'none' | undefined;
  resumeSummary: string | undefined;
  resumeThreadId: string | undefined;
  staticIds: React.MutableRefObject<Set<string>>;
  setStaticEntries: React.Dispatch<React.SetStateAction<StaticEntry[]>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

interface StreamProcessorResult {
  streamingParticipants: string[];
  waitingParticipants: string[];
  orchestratorMessages: OrchestratorMessage[];
  compactionNotice: string | null;
  planProgress: PlanProgress | null;
  pendingPlanApproval: PendingPlanApproval | null;
  agentActivity: Map<string, AgentActivityEntry[]>;
  pendingUrlConfirmation: PendingUrlConfirmation | null;
  pendingToolApproval: PendingToolApproval | null;
  graphRef: React.MutableRefObject<OrchestrationGraph | null>;
  streamFlushRef: React.MutableRefObject<Map<string, StreamFlushBuffer>>;
  streamingMessageIds: React.MutableRefObject<Set<string>>;
  streamingOrder: React.MutableRefObject<string[]>;
  userMessageCount: React.MutableRefObject<number>;
  modelResponseCount: React.MutableRefObject<number>;
  sessionStartTime: React.MutableRefObject<Date>;
  handleSubmit: (content: string, directedTo?: string[]) => void;
  handleUrlConfirmation: (fetchContent: boolean) => void;
  handleToolApproval: (approved: boolean, budget: number) => void;
  cancelAll: () => void;
  sendMessage: (
    content: string,
    directedTo?: string[],
    fetchWebContent?: boolean,
    approvedAnalysis?: OrchestratorAnalysis,
  ) => Promise<void>;
  setOrchestratorMessages: React.Dispatch<React.SetStateAction<OrchestratorMessage[]>>;
  setPendingPlanApproval: React.Dispatch<React.SetStateAction<PendingPlanApproval | null>>;
  setPlanProgress: React.Dispatch<React.SetStateAction<PlanProgress | null>>;
}

export function useStreamProcessor({
  sessionId,
  participants,
  resumeMode,
  resumeSummary,
  resumeThreadId,
  staticIds,
  setStaticEntries,
  setMessages,
  setError,
}: UseStreamProcessorParams): StreamProcessorResult {
  const [streamingParticipants, setStreamingParticipants] = useState<string[]>([]);
  const [waitingParticipants, setWaitingParticipants] = useState<string[]>([]);
  const [orchestratorMessages, setOrchestratorMessages] = useState<OrchestratorMessage[]>([]);
  const [pendingPlanApproval, setPendingPlanApproval] = useState<PendingPlanApproval | null>(null);
  const [planProgress, setPlanProgress] = useState<PlanProgress | null>(null);
  const [pendingUrlConfirmation, setPendingUrlConfirmation] = useState<PendingUrlConfirmation | null>(null);
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | null>(null);
  const [compactionNotice, setCompactionNotice] = useState<string | null>(null);
  const [agentActivity, setAgentActivity] = useState<Map<string, AgentActivityEntry[]>>(new Map());

  const graphRef = useRef<OrchestrationGraph | null>(null);
  const latestAnalysisRef = useRef<OrchestratorAnalysis | null>(null);
  const streamingOrder = useRef<string[]>([]);
  const streamingMessageIds = useRef(new Set<string>());
  const streamFlushRef = useRef(new Map<string, StreamFlushBuffer>());
  const guidanceRef = useRef(new Map<string, string>());
  const summaryInjected = useRef(false);
  const sessionStartTime = useRef(new Date());
  const userMessageCount = useRef(0);
  const modelResponseCount = useRef(0);

  // Auto-clear compaction notice after 4 seconds
  useEffect(() => {
    if (!compactionNotice) return;
    const timer = setTimeout(() => setCompactionNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [compactionNotice]);

  const sendMessage = useCallback(
    async (
      content: string,
      directedTo?: string[],
      fetchWebContent = false,
      approvedAnalysis?: OrchestratorAnalysis,
    ) => {
      const user = participants.find(p => p.type === 'user');
      if (!user) return;

      let targetIds = directedTo;
      if (!approvedAnalysis) {
        if (!targetIds) {
          const parseResult = parseMentions(content, { participants });
          if (parseResult.type !== 'broadcast') {
            targetIds = parseResult.targetIds;
          }
        }

        const userMessage = createUserMessage(
          sessionId, user.id, content, targetIds,
        );
        logMessage('create', userMessage.id, {
          type: 'user', targetIds,
        });
        logChatMessage(user.displayName, content, true);
        addMessage(sessionId, userMessage);

        const sentMessage = markMessageSent(userMessage);
        updateMessage(sessionId, userMessage.id, sentMessage);
        staticIds.current.add(userMessage.id);
        setStaticEntries(prev => [...prev, { id: userMessage.id, kind: 'message' as const, message: sentMessage }]);
        setMessages([...getMessages(sessionId)]);
        userMessageCount.current += 1;
      }

      // Reset streaming state
      setStreamingParticipants([]);
      setWaitingParticipants([]);
      if (!approvedAnalysis) {
        setOrchestratorMessages([] as OrchestratorMessage[]);
        setPlanProgress(null);
      }
      setPendingPlanApproval(null);

      try {
        const graph = await getOrCompileGraph(sessionId, { workingDir: process.cwd() });
        graphRef.current = graph;
        const idMap = graph.agentToParticipant;

        const participantToAgent = new Map<string, string>();
        for (const [agentId, participantId] of idMap) {
          participantToAgent.set(participantId, agentId);
        }

        let directedAgentIds: string[] | undefined;
        if (targetIds && targetIds.length > 0) {
          directedAgentIds = targetIds
            .map(pid => participantToAgent.get(pid))
            .filter((id): id is string => id !== undefined);
        }

        const placeholders = new Map<string, ReturnType<typeof createPlaceholder>>();
        const targetParticipantIds = directedAgentIds
          ? directedAgentIds.map(aid => idMap.get(aid)).filter((id): id is string => id !== undefined)
          : [...idMap.values()];

        for (const pid of targetParticipantIds) {
          const placeholder = createPlaceholder(sessionId, pid);
          placeholders.set(pid, placeholder);
          streamingMessageIds.current.add(placeholder.id);
          setWaitingParticipants(prev => prev.includes(pid) ? prev : [...prev, pid]);
        }

        let conversationHistory: ConversationHistoryEntry[] | undefined;
        if (resumeMode === 'summary' && resumeSummary && !summaryInjected.current) {
          conversationHistory = [{
            role: 'user',
            content: `[Previous conversation summary]\n${resumeSummary}`,
          }];
          summaryInjected.current = true;
        }

        const startedAgents = new Set<string>();
        const markAgentStarted = (agentId: string, participantId: string): void => {
          if (startedAgents.has(agentId)) return;
          startedAgents.add(agentId);
          setWaitingParticipants(prev => prev.filter(id => id !== participantId));
          setStreamingParticipants(prev => prev.includes(participantId) ? prev : [...prev, participantId]);
          if (!streamingOrder.current.includes(participantId)) {
            streamingOrder.current.push(participantId);
          }
        };

        // Build shared handler context
        const ctx: StreamHandlerContext = {
          sessionId, participants, idMap, placeholders, startedAgents,
          streamFlushRef, streamingMessageIds, streamingOrder, guidanceRef,
          staticIds, modelResponseCount, graphRef, latestAnalysisRef,
          setStaticEntries, setStreamingParticipants, setWaitingParticipants,
          setMessages, setOrchestratorMessages, setPendingToolApproval,
          setPendingPlanApproval, setPlanProgress, setCompactionNotice,
          setAgentActivity, markAgentStarted,
        };

        for await (const event of graph.stream({
          message: content,
          sessionId,
          threadId: resumeThreadId,
          directedTo: directedAgentIds,
          fetchUrls: fetchWebContent,
          conversationHistory,
          ...(approvedAnalysis ? { approvedAnalysis } : {}),
        })) {
          const streamEvent = event as OrchestrationStreamEvent;

          switch (streamEvent.type) {
            case 'token':               handleTokenEvent(streamEvent, ctx); break;
            case 'start':               handleStartEvent(streamEvent, ctx); break;
            case 'complete':            handleCompleteEvent(streamEvent, ctx); break;
            case 'error':               handleErrorEvent(streamEvent, ctx); break;
            case 'approval_required':   handleApprovalRequired(streamEvent, ctx); break;
            case 'approval_result':     handleApprovalResult(ctx); break;
            case 'orchestrator_analysis': handleOrchestratorAnalysis(streamEvent, ctx); break;
            case 'orchestrator_plan':     handleOrchestratorPlan(streamEvent, ctx, content); break;
            case 'orchestrator_round':    handleOrchestratorRound(streamEvent, ctx); break;
            case 'orchestrator_direct':   handleOrchestratorDirect(streamEvent, ctx); break;
            case 'orchestrator_complete': handleOrchestratorComplete(streamEvent, ctx); break;
            case 'compaction_status':  handleCompactionStatus(streamEvent, ctx); break;
            case 'agent_activity':    handleAgentActivity(streamEvent, ctx); break;
            default: break;
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        streamingMessageIds.current.clear();
        streamFlushRef.current.clear();
        guidanceRef.current.clear();
        setStreamingParticipants([]);
        setWaitingParticipants([]);
        setPendingToolApproval(null);
        setAgentActivity(new Map());
        streamingOrder.current = [];
        setMessages([...getMessages(sessionId)]);
      }
    },
    [sessionId, participants],
  );

  const handleSubmit = useCallback(
    (content: string, directedTo?: string[]) => {
      const urls = detectUrls(content);
      if (urls.length > 0) {
        setPendingUrlConfirmation({
          content,
          ...(directedTo && { directedTo }),
          urls,
        });
      } else {
        void sendMessage(content, directedTo, false);
      }
    },
    [sendMessage],
  );

  const handleUrlConfirmation = useCallback(
    (fetchContent: boolean) => {
      if (!pendingUrlConfirmation) return;
      const { content, directedTo } = pendingUrlConfirmation;
      setPendingUrlConfirmation(null);
      void sendMessage(content, directedTo, fetchContent);
    },
    [pendingUrlConfirmation, sendMessage],
  );

  const handleToolApproval = useCallback(
    (approved: boolean, budget: number) => {
      if (!pendingToolApproval || !graphRef.current) return;
      const { approvalId } = pendingToolApproval;
      setPendingToolApproval(null);
      void graphRef.current.respondToApproval(approvalId, approved, budget);
    },
    [pendingToolApproval],
  );

  const cancelAll = useCallback(() => {
    graphRef.current?.cancelAll();
  }, []);

  return {
    streamingParticipants, waitingParticipants, orchestratorMessages, compactionNotice, agentActivity,
    planProgress, pendingPlanApproval, pendingUrlConfirmation, pendingToolApproval,
    graphRef, streamFlushRef, streamingMessageIds, streamingOrder,
    userMessageCount, modelResponseCount, sessionStartTime,
    handleSubmit, handleUrlConfirmation, handleToolApproval, cancelAll,
    sendMessage, setOrchestratorMessages, setPendingPlanApproval, setPlanProgress,
  };
}
