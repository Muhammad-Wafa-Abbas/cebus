/**
 * Handle compaction_status stream events.
 * Shows a per-agent transient notice near the input area.
 */

import type { OrchestrationStreamEvent } from '../../../orchestration/types.js';
import type { StreamHandlerContext } from './types';

type CompactionStatusEvent = Extract<OrchestrationStreamEvent, { type: 'compaction_status' }>;

/** Format a token count as a human-readable string (e.g. 8192 → "8.2K"). */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(tokens);
}

/** Handle 'compaction_status': show a per-agent transient compaction notice. */
export function handleCompactionStatus(
  event: CompactionStatusEvent,
  ctx: StreamHandlerContext,
): void {
  const { compactedMessages, summarized, windowTokens, tokenBudget, source } = event;
  const name = event.agentName ?? event.agentId;

  // SDK-sourced event with actual compaction (from session.compaction_complete)
  if (source === 'sdk' && summarized) {
    ctx.setCompactionNotice(`✂ ${name}: SDK auto-compacted context`);
    return;
  }

  // Don't show when nothing was compacted
  if (compactedMessages === 0) return;

  const tokenInfo = windowTokens !== undefined && tokenBudget !== undefined
    ? ` (~${formatTokenCount(windowTokens)}/${formatTokenCount(tokenBudget)} tokens)`
    : '';

  let content: string;
  if (summarized) {
    content = `✂ ${name}: Compacted ${compactedMessages} messages into summary${tokenInfo}`;
  } else {
    content = `✂ ${name}: Truncated ${compactedMessages} older messages${tokenInfo}`;
  }

  ctx.setCompactionNotice(content);
}
