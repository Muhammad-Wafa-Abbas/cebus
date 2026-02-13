/**
 * Handle orchestrator stream events (analysis, plan, round, direct, complete).
 */

import type { OrchestrationStreamEvent } from '../../../orchestration/types.js';
import type { StreamHandlerContext } from './types';

type OrchestratorAnalysisEvent = Extract<OrchestrationStreamEvent, { type: 'orchestrator_analysis' }>;
type OrchestratorPlanEvent = Extract<OrchestrationStreamEvent, { type: 'orchestrator_plan' }>;
type OrchestratorRoundEvent = Extract<OrchestrationStreamEvent, { type: 'orchestrator_round' }>;
type OrchestratorDirectEvent = Extract<OrchestrationStreamEvent, { type: 'orchestrator_direct' }>;
type OrchestratorCompleteEvent = Extract<OrchestrationStreamEvent, { type: 'orchestrator_complete' }>;

/** Handle 'orchestrator_analysis': store analysis and add a message. */
export function handleOrchestratorAnalysis(
  event: OrchestratorAnalysisEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.latestAnalysisRef.current = event.analysis;
  ctx.setOrchestratorMessages(prev => [
    ...prev,
    { kind: 'analysis', content: `Analyzing: ${event.analysis.intent} [${event.analysis.complexity}]`, timestamp: new Date() },
  ]);
}

/** Handle 'orchestrator_plan': show plan approval or log the plan. */
export function handleOrchestratorPlan(
  event: OrchestratorPlanEvent,
  ctx: StreamHandlerContext,
  originalMessage: string,
): void {
  if (event.awaitingApproval && ctx.latestAnalysisRef.current) {
    ctx.setPendingPlanApproval({
      plan: event.plan,
      analysis: ctx.latestAnalysisRef.current,
      originalMessage,
    });
  } else {
    const stepsSummary = event.plan.steps.map((s, i) => `${i + 1}. ${s.agentId}: ${s.action}`).join(', ');
    ctx.setOrchestratorMessages(prev => [
      ...prev,
      { kind: 'plan', content: `Plan: ${event.plan.description} (${stepsSummary})`, timestamp: new Date() },
    ]);
  }
}

/** Handle 'orchestrator_round': update progress and add a message. */
export function handleOrchestratorRound(event: OrchestratorRoundEvent, ctx: StreamHandlerContext): void {
  ctx.setOrchestratorMessages(prev => [
    ...prev,
    { kind: 'round', content: `Round ${event.round}/${event.maxRounds} — ${event.nextAgent}: ${event.reason}`, timestamp: new Date() },
  ]);
  ctx.setPlanProgress(prev => prev ? { ...prev, completed: event.round, activeAgent: event.nextAgent } : null);
}

/** Handle 'orchestrator_direct': add a direct orchestrator response. */
export function handleOrchestratorDirect(event: OrchestratorDirectEvent, ctx: StreamHandlerContext): void {
  ctx.setOrchestratorMessages(prev => [...prev, { kind: 'direct', content: event.content, timestamp: new Date() }]);
}

/** Handle 'orchestrator_complete': mark plan done and add summary. */
export function handleOrchestratorComplete(event: OrchestratorCompleteEvent, ctx: StreamHandlerContext): void {
  ctx.setPlanProgress(prev => prev ? { ...prev, completed: prev.plan.steps.length, activeAgent: null } : null);
  ctx.setOrchestratorMessages(prev => [
    ...prev,
    {
      kind: 'complete',
      content: event.summary,
      timestamp: new Date(),
      ...(event.taskSummary ? { taskSummary: event.taskSummary } : {}),
    },
  ]);
}
