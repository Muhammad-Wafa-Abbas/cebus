/**
 * Handle 'agent_activity' stream events.
 *
 * Maps agentId → participantId and accumulates an activity log
 * so the ThinkingIndicator can show what each agent is doing with
 * ● / └ formatting (completed entries + results).
 */

import type { OrchestrationStreamEvent } from '../../../orchestration/types.js';
import type { StreamHandlerContext } from './types';
import type { AgentActivityEntry } from '../../chat-types';

type AgentActivityEvent = Extract<OrchestrationStreamEvent, { type: 'agent_activity' }>;

export function handleAgentActivity(event: AgentActivityEvent, ctx: StreamHandlerContext): void {
  const participantId = ctx.idMap.get(event.agentId);
  if (!participantId) return;

  // Move from waiting → streaming on first visible activity
  ctx.markAgentStarted(event.agentId, participantId);

  ctx.setAgentActivity(prev => {
    const next = new Map(prev);
    const entries: AgentActivityEntry[] = [...(next.get(participantId) ?? [])];

    switch (event.kind) {
      case 'start':
        entries.push({ activity: event.activity });
        break;
      case 'progress': {
        const last = entries[entries.length - 1];
        if (last) {
          last.result = event.activity;
        }
        break;
      }
      case 'complete': {
        const last = entries[entries.length - 1];
        if (last && event.result) {
          last.result = event.result;
        }
        break;
      }
      default:
        // Legacy: single-string behavior — push new entry
        entries.push({ activity: event.activity });
    }

    next.set(participantId, entries);
    return next;
  });
}
