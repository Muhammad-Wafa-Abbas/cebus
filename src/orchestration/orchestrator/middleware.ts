
import { AIMessage } from '@langchain/core/messages';
import type { OrchestrationStateType } from '../state.js';
import {
  ORCHESTRATOR_AGENT_ID,
  type TeamConfig,
  type AgentProfile,
  type OrchestratorAnalysis,
  type OrchestratorPlan,
  type OrchestrationStreamEvent,
  type ExecutionContext,
  type AgentContribution,
  type TaskCompletionSummary,
} from '../types.js';
import { type OrchestratorLLM, createOrchestratorLLM } from './llm.js';
import { loadOrchestratorPrompt } from '../config/defaults.js';
import { debug } from '../../core/debug-logger.js';

interface StreamCallbackRef {
  current: ((event: OrchestrationStreamEvent) => void) | undefined;
}

function getCapabilityTag(agent: AgentProfile): string {
  return agent.provider?.type === 'copilot'
    ? '[can execute: file editing, shell commands]'
    : '[chat only]';
}

function buildAgentDescription(agent: AgentProfile): string {
  const skills = agent.skills?.length ? ` [Skills: ${agent.skills.join(', ')}]` : '';
  const cap = getCapabilityTag(agent);
  return `- ${agent.id}: ${agent.name} — ${agent.role} ${cap}${skills}`;
}

function getTeamCapabilityNotice(agents: readonly AgentProfile[]): string {
  const hasExecAgent = agents.some(a => a.provider?.type === 'copilot');
  if (hasExecAgent) return '';
  return '\n\n## IMPORTANT: Discussion-Only Mode\nNo agents in this chat can execute code changes (no [can execute] agents). All agents are [chat only]. You may discuss, plan, and advise, but CANNOT assign implementation tasks. If the user asks for code changes, explain that no execution-capable agent is available and suggest adding a Copilot model.';
}

/**
 * Create the analyzer node that runs BEFORE routing.
 * Analyzes user message intent, complexity, safety, and selects target agents.
 */
export function createAnalyzerNode(
  config: TeamConfig,
  streamCallbackRef: StreamCallbackRef,
  abortControllers?: Map<string, AbortController>,
): (state: OrchestrationStateType) => Promise<Partial<OrchestrationStateType>> {
  let llm: OrchestratorLLM | null = null;

  return async (state: OrchestrationStateType): Promise<Partial<OrchestrationStateType>> => {
    const traceId = state.currentTraceId;
    const orchestratorConfig = config.orchestrator;
    if (!orchestratorConfig) {
      return {};
    }

    const orchestratorMentioned = state.directedTo.includes(ORCHESTRATOR_AGENT_ID);
    if (orchestratorMentioned) {
      await handleOrchestratorConversation(
        state,
        orchestratorConfig,
        config,
        streamCallbackRef,
      );

      const otherTargets = state.directedTo.filter(id => id !== ORCHESTRATOR_AGENT_ID);
      if (otherTargets.length === 0) {
        return { isComplete: true };
      }

      return { directedTo: otherTargets };
    }

    if (state.orchestratorPlanApproved && state.orchestratorAnalysis) {
      const analysis = state.orchestratorAnalysis;
      const emit = streamCallbackRef.current;
      emit?.({ type: 'orchestrator_analysis', traceId, analysis });

      const executionContexts: Record<string, ExecutionContext> = {};
      for (const agentId of analysis.selectedAgents) {
        const controller = new AbortController();
        abortControllers?.set(agentId, controller);
        executionContexts[agentId] = {
          activeAgentId: agentId,
          allowedTools: ['*'],
          routingReason: `Orchestrator: ${analysis.intent}`,
          timeoutBudget: 120000,
          cancellationToken: controller.signal,
          orchestratorGuidance: analysis.agentInstructions[agentId],
        };
      }

      return {
        orchestratorAnalysis: analysis,
        activeAgentId: analysis.selectedAgents[0] ?? null,
        pendingAgents: analysis.selectedAgents.slice(1),
        executionContexts,
        orchestratorMaxRounds: orchestratorConfig.maxRounds ?? 5,
        orchestratorRound: 0,
      };
    }

    if (!llm) {
      const routingConfig = {
        ...(orchestratorConfig.model ? { model: orchestratorConfig.model } : {}),
        ...(orchestratorConfig.provider ? { provider: orchestratorConfig.provider } : {}),
      };
      llm = await createOrchestratorLLM(routingConfig);
    }

    const lastHumanMessage = [...state.messages]
      .reverse()
      .find((m) => m._getType() === 'human');
    const userMessage =
      typeof lastHumanMessage?.content === 'string' ? lastHumanMessage.content : '';

    const agentDescriptions = config.agents
      .map((a) => buildAgentDescription(a))
      .join('\n');

    const recentHistory = state.messages
      .slice(-10)
      .map((m) => {
        const role = m._getType() === 'human' ? 'User' : (m as AIMessage).name ?? 'Agent';
        const content = typeof m.content === 'string' ? m.content : '';
        return `${role}: ${content.slice(0, 200)}`;
      })
      .join('\n');

    const analyzerPrompt = loadOrchestratorPrompt('analyzer.md');
    const capabilityNotice = getTeamCapabilityNotice(config.agents);
    const systemPrompt = `${analyzerPrompt}

## Available Agents
${agentDescriptions}

## Chat Mode
${config.conversationMode}

## Recent Conversation
${recentHistory || '(no prior messages)'}

## Agent IDs (use these exact IDs in your response)
${config.agents.map((a) => a.id).join(', ')}${capabilityNotice}`;

    const emit = streamCallbackRef.current;

    try {
      const content = await llm.invoke(systemPrompt, userMessage);
      const analysis = parseAnalyzerResponse(content, config);

      emit?.({ type: 'orchestrator_analysis', traceId, analysis });

      if (analysis.directResponse) {
        emit?.({ type: 'orchestrator_direct', traceId, content: analysis.directResponse });
        return {
          orchestratorAnalysis: analysis,
          isComplete: true,
        };
      }

      if (analysis.needsApproval && analysis.plan) {
        emit?.({
          type: 'orchestrator_plan',
          traceId,
          plan: analysis.plan,
          awaitingApproval: true,
        });
        return {
          orchestratorAnalysis: analysis,
          systemCommand: 'await_approval',
          orchestratorMaxRounds: orchestratorConfig.maxRounds ?? 5,
        };
      }

      const executionContexts: Record<string, ExecutionContext> = {};
      for (const agentId of analysis.selectedAgents) {
        const controller = new AbortController();
        abortControllers?.set(agentId, controller);
        executionContexts[agentId] = {
          activeAgentId: agentId,
          allowedTools: ['*'],
          routingReason: `Orchestrator: ${analysis.intent}`,
          timeoutBudget: 120000,
          cancellationToken: controller.signal,
          orchestratorGuidance: analysis.agentInstructions[agentId],
        };
      }

      return {
        orchestratorAnalysis: analysis,
        activeAgentId: analysis.selectedAgents[0] ?? null,
        pendingAgents: analysis.selectedAgents.slice(1),
        executionContexts,
        orchestratorMaxRounds: orchestratorConfig.maxRounds ?? 5,
        orchestratorRound: 0,
      };
    } catch (err) {
      debug('orchestrator', 'analyzer-failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  };
}

/**
 * Create the evaluator node that runs AFTER each agent response.
 * Decides: complete, next round, or max rounds reached.
 */
export function createEvaluatorNode(
  config: TeamConfig,
  streamCallbackRef: StreamCallbackRef,
  abortControllers?: Map<string, AbortController>,
): (state: OrchestrationStateType) => Promise<Partial<OrchestrationStateType>> {
  let llm: OrchestratorLLM | null = null;

  return async (state: OrchestrationStateType): Promise<Partial<OrchestrationStateType>> => {
    const traceId = state.currentTraceId;
    const orchestratorConfig = config.orchestrator;
    const analysis = state.orchestratorAnalysis;
    if (!orchestratorConfig || !analysis) {
      return { isComplete: true };
    }

    const round = state.orchestratorRound + 1;
    const maxRounds = state.orchestratorMaxRounds;
    const emit = streamCallbackRef.current;

    if (round >= maxRounds) {
      const taskSummary = analysis.plan
        ? buildTaskSummary(state, config, analysis, maxRounds, undefined)
        : undefined;
      emit?.({
        type: 'orchestrator_complete',
        traceId,
        summary: `Task completed after ${round} round(s) (max rounds reached).`,
        ...(taskSummary ? { taskSummary } : {}),
      });
      return {
        orchestratorRound: round,
        isComplete: true,
      };
    }

    if (!analysis.plan) {
      emit?.({
        type: 'orchestrator_complete',
        traceId,
        summary: `Task completed in ${round} round(s).`,
      });
      return {
        orchestratorRound: round,
        isComplete: true,
      };
    }

    if (!llm) {
      const routingConfig = {
        ...(orchestratorConfig.model ? { model: orchestratorConfig.model } : {}),
        ...(orchestratorConfig.provider ? { provider: orchestratorConfig.provider } : {}),
      };
      llm = await createOrchestratorLLM(routingConfig);
    }

    const agentMessages = state.messages.filter((m) => m._getType() === 'ai');
    const conversationDigest = agentMessages
      .map((m) => {
        const aiMsg = m as AIMessage;
        const agentId = aiMsg.name ?? 'unknown';
        const content = typeof aiMsg.content === 'string' ? aiMsg.content : '';
        return `[${agentId}]: ${content.slice(0, 300)}${content.length > 300 ? '...' : ''}`;
      })
      .join('\n\n');

    const lastAiMessage = agentMessages.at(-1);
    const lastResponse = typeof lastAiMessage?.content === 'string'
      ? lastAiMessage.content : '';
    const lastAgentId = (lastAiMessage as AIMessage | undefined)?.name ?? '';

    const evaluatorPrompt = loadOrchestratorPrompt('evaluator.md');
    const agentDescriptions = config.agents
      .map((a) => buildAgentDescription(a))
      .join('\n');
    const capabilityNotice = getTeamCapabilityNotice(config.agents);

    const systemPrompt = `${evaluatorPrompt}

## Plan
${analysis.plan.description}
Steps: ${analysis.plan.steps.map((s, i) => `${i + 1}. ${s.agentId}: ${s.action}`).join(', ')}

## Available Agents
${agentDescriptions}

## Current State
Round: ${round}/${maxRounds}
Last agent: ${lastAgentId}
Original intent: ${analysis.intent}

## Agent IDs
${config.agents.map((a) => a.id).join(', ')}${capabilityNotice}`;

    try {
      const content = await llm.invoke(
        systemPrompt,
        `## Discussion So Far\n${conversationDigest.slice(0, 3000)}\n\n## Latest Response (${lastAgentId})\n${lastResponse.slice(0, 2000)}`,
      );
      const evaluation = parseEvaluatorResponse(content, config);

      if (evaluation.isComplete) {
        const taskSummary = analysis.plan
          ? buildTaskSummary(state, config, analysis, maxRounds, evaluation.executiveSummary)
          : undefined;
        emit?.({
          type: 'orchestrator_complete',
          traceId,
          summary: evaluation.summary ?? `Task completed in ${round} round(s).`,
          ...(taskSummary ? { taskSummary } : {}),
        });
        return {
          orchestratorRound: round,
          isComplete: true,
        };
      }

      if (evaluation.nextAgentId) {
        emit?.({
          type: 'orchestrator_round',
          traceId,
          round,
          maxRounds,
          nextAgent: evaluation.nextAgentId,
          reason: evaluation.reason ?? 'Continuing task',
        });

        const nextController = new AbortController();
        abortControllers?.set(evaluation.nextAgentId, nextController);
        const executionContexts: Record<string, ExecutionContext> = {
          [evaluation.nextAgentId]: {
            activeAgentId: evaluation.nextAgentId,
            allowedTools: ['*'],
            routingReason: evaluation.reason ?? 'Orchestrator continuation',
            timeoutBudget: 120000,
            cancellationToken: nextController.signal,
            orchestratorGuidance: evaluation.guidance ?? evaluation.reason,
          },
        };

        return {
          orchestratorRound: round,
          activeAgentId: evaluation.nextAgentId,
          pendingAgents: [],
          executionContexts,
          isComplete: false,
        };
      }

      {
        const taskSummary = analysis.plan
          ? buildTaskSummary(state, config, analysis, maxRounds, undefined)
          : undefined;
        emit?.({
          type: 'orchestrator_complete',
          traceId,
          summary: `Task completed in ${round} round(s).`,
          ...(taskSummary ? { taskSummary } : {}),
        });
        return {
          orchestratorRound: round,
          isComplete: true,
        };
      }
    } catch (err) {
      debug('orchestrator', 'evaluator-failed', {
        error: err instanceof Error ? err.message : String(err),
        round,
        maxRounds,
      });
      const taskSummary = analysis.plan
        ? buildTaskSummary(state, config, analysis, maxRounds, undefined)
        : undefined;
      emit?.({
        type: 'orchestrator_complete',
        traceId,
        summary: `Task completed in ${round} round(s) (evaluator error).`,
        ...(taskSummary ? { taskSummary } : {}),
      });
      return {
        orchestratorRound: round,
        isComplete: true,
      };
    }
  };
}

/**
 * Build a TaskCompletionSummary from state and config.
 * Deterministically extracts agent contributions from messages.
 */
function buildTaskSummary(
  state: OrchestrationStateType,
  config: TeamConfig,
  analysis: OrchestratorAnalysis,
  maxRounds: number,
  executiveSummary: string | undefined,
): TaskCompletionSummary {
  const agentMap = new Map(config.agents.map((a) => [a.id, a]));

  const contributions: AgentContribution[] = [];
  let currentRound = 1;
  let lastAgentId: string | undefined;

  for (const msg of state.messages) {
    if (msg._getType() !== 'ai') continue;
    const aiMsg = msg as AIMessage;
    const agentId = aiMsg.name ?? '';
    if (!agentId || !agentMap.has(agentId)) continue;

    const agent = agentMap.get(agentId)!;
    const content = typeof aiMsg.content === 'string' ? aiMsg.content : '';
    if (content.length === 0) continue;

    if (lastAgentId !== undefined && agentId !== lastAgentId) {
      currentRound++;
    }
    lastAgentId = agentId;

    const planStep = analysis.plan?.steps.find((s) => s.agentId === agentId);
    const action = planStep?.action
      ?? analysis.agentInstructions[agentId]
      ?? agent.role;

    let excerpt = content.slice(0, 150).trim();
    if (content.length > 150) {
      const lastSpace = excerpt.lastIndexOf(' ');
      if (lastSpace > 80) {
        excerpt = excerpt.slice(0, lastSpace);
      }
      excerpt += '...';
    }

    contributions.push({
      agentId,
      agentName: agent.name,
      role: agent.role,
      action,
      excerpt,
      round: currentRound,
    });
  }

  return {
    executiveSummary: executiveSummary ?? analysis.plan?.description ?? 'Task completed.',
    contributions,
    metadata: {
      intent: analysis.intent,
      complexity: analysis.complexity,
      totalRounds: state.orchestratorRound + 1,
      maxRounds,
      ...(analysis.plan ? { planDescription: analysis.plan.description } : {}),
    },
  };
}

let conversationLlm: OrchestratorLLM | null = null;

/**
 * Handle an @Orchestrator mention by streaming a conversational response.
 * Uses the conversation.md prompt and emits start/token/complete events
 * with agentId = ORCHESTRATOR_AGENT_ID.
 */
async function handleOrchestratorConversation(
  state: OrchestrationStateType,
  orchestratorConfig: NonNullable<TeamConfig['orchestrator']>,
  config: TeamConfig,
  streamCallbackRef: StreamCallbackRef,
): Promise<void> {
  const traceId = state.currentTraceId;
  const emit = streamCallbackRef.current;

  if (!conversationLlm) {
    const routingConfig = {
      ...(orchestratorConfig.model ? { model: orchestratorConfig.model } : {}),
      ...(orchestratorConfig.provider ? { provider: orchestratorConfig.provider } : {}),
    };
    conversationLlm = await createOrchestratorLLM(routingConfig);
  }

  const lastHumanMessage = [...state.messages]
    .reverse()
    .find((m) => m._getType() === 'human');
  const userMessage =
    typeof lastHumanMessage?.content === 'string' ? lastHumanMessage.content : '';

  const agentDescriptions = config.agents
    .map((a) => {
      const cap = getCapabilityTag(a);
      return `- @${a.id}: ${a.name} — ${a.role} ${cap}`;
    })
    .join('\n');

  const recentHistory = state.messages
    .slice(-10)
    .map((m) => {
      const role = m._getType() === 'human' ? 'User' : (m as AIMessage).name ?? 'Agent';
      const content = typeof m.content === 'string' ? m.content : '';
      return `${role}: ${content.slice(0, 300)}`;
    })
    .join('\n');

  const conversationPrompt = loadOrchestratorPrompt('conversation.md');
  const systemPrompt = `${conversationPrompt || 'You are the Orchestrator, an AI coordinator for this multi-agent group chat. Respond naturally and helpfully.'}

## Agents in This Chat
${agentDescriptions}

## Recent Conversation
${recentHistory || '(no prior messages)'}`;

  emit?.({ type: 'start', agentId: ORCHESTRATOR_AGENT_ID, traceId });

  try {
    let fullContent = '';
    for await (const token of conversationLlm.stream(systemPrompt, userMessage)) {
      fullContent += token;
      emit?.({ type: 'token', agentId: ORCHESTRATOR_AGENT_ID, traceId, token });
    }

    emit?.({ type: 'complete', agentId: ORCHESTRATOR_AGENT_ID, traceId, content: fullContent });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    emit?.({
      type: 'error',
      agentId: ORCHESTRATOR_AGENT_ID,
      traceId,
      error: {
        code: 'WORKER_EXECUTION',
        message: `Orchestrator conversation error: ${errorMsg}`,
        agentId: ORCHESTRATOR_AGENT_ID,
        recoverable: true,
      },
    });
  }
}

/**
 * Parse the analyzer LLM response into a OrchestratorAnalysis.
 * Attempts JSON extraction, falls back to routing all agents.
 */
function parseAnalyzerResponse(
  response: string,
  config: TeamConfig,
): OrchestratorAnalysis {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      let selectedAgents: string[] = [];
      if (Array.isArray(parsed['selectedAgents'])) {
        selectedAgents = (parsed['selectedAgents'] as string[])
          .filter((id) => config.agents.some((a) => a.id === id));
      }

      if (selectedAgents.length === 0 && !parsed['directResponse']) {
        selectedAgents = [config.agents[0]?.id ?? ''];
      }

      let plan: OrchestratorPlan | undefined;
      if (parsed['plan'] && typeof parsed['plan'] === 'object') {
        const rawPlan = parsed['plan'] as Record<string, unknown>;
        if (Array.isArray(rawPlan['steps'])) {
          plan = {
            description: String(rawPlan['description'] ?? ''),
            steps: (rawPlan['steps'] as Array<Record<string, unknown>>).map((s) => ({
              agentId: String(s['agentId'] ?? ''),
              action: String(s['action'] ?? ''),
              ...(s['dependsOn'] !== undefined ? { dependsOn: Number(s['dependsOn']) } : {}),
            })),
            estimatedRounds: Number(rawPlan['estimatedRounds'] ?? 1),
            estimatedCost: (['low', 'medium', 'high'].includes(String(rawPlan['estimatedCost']))
              ? String(rawPlan['estimatedCost'])
              : 'low') as 'low' | 'medium' | 'high',
          };
        }
      }

      return {
        intent: String(parsed['intent'] ?? 'unknown'),
        complexity: (['simple', 'moderate', 'complex'].includes(String(parsed['complexity']))
          ? String(parsed['complexity'])
          : 'simple') as 'simple' | 'moderate' | 'complex',
        safetyFlags: Array.isArray(parsed['safetyFlags'])
          ? (parsed['safetyFlags'] as string[])
          : [],
        plan,
        selectedAgents,
        agentInstructions: (typeof parsed['agentInstructions'] === 'object' && parsed['agentInstructions'] !== null)
          ? parsed['agentInstructions'] as Record<string, string>
          : {},
        directResponse: typeof parsed['directResponse'] === 'string' && selectedAgents.length === 0
          ? parsed['directResponse']
          : undefined,
        needsApproval: Boolean(parsed['needsApproval']),
      };
    } catch (parseErr) {
      debug('orchestrator', 'analyzer-json-parse-failed', {
        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
    }
  }

  return {
    intent: 'general',
    complexity: 'simple',
    safetyFlags: [],
    selectedAgents: config.agents.map((a) => a.id),
    agentInstructions: {},
    needsApproval: false,
  };
}

interface EvaluatorResult {
  isComplete: boolean;
  nextAgentId?: string | undefined;
  reason?: string | undefined;
  guidance?: string | undefined;
  summary?: string | undefined;
  executiveSummary?: string | undefined;
}

/**
 * Parse the evaluator LLM response into a decision.
 */
function parseEvaluatorResponse(
  response: string,
  config: TeamConfig,
): EvaluatorResult {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      const isComplete = Boolean(parsed['isComplete'] ?? parsed['complete'] ?? false);
      if (isComplete) {
        return {
          isComplete: true,
          summary: typeof parsed['summary'] === 'string' ? parsed['summary'] : undefined,
          executiveSummary: typeof parsed['executiveSummary'] === 'string' ? parsed['executiveSummary'] : undefined,
        };
      }

      const nextAgentId = typeof parsed['nextAgentId'] === 'string'
        ? parsed['nextAgentId']
        : typeof parsed['nextAgent'] === 'string'
          ? parsed['nextAgent']
          : undefined;

      // Validate agent exists
      if (nextAgentId && config.agents.some((a) => a.id === nextAgentId)) {
        return {
          isComplete: false,
          nextAgentId,
          reason: typeof parsed['reason'] === 'string' ? parsed['reason'] : undefined,
          guidance: typeof parsed['guidance'] === 'string' ? parsed['guidance'] : undefined,
        };
      }

      // Invalid next agent — complete
      return { isComplete: true, summary: 'Task completed.' };
    } catch (parseErr) {
      debug('orchestrator', 'evaluator-json-parse-failed', {
        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
    }
  }

  return { isComplete: true, summary: 'Task completed.' };
}
