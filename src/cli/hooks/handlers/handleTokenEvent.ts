/**
 * Handle 'token' and 'start' stream events.
 *
 * Appends tokens to the store, manages per-participant flush buffers,
 * and emits stream headers on first token per participant.
 */

import { appendToken } from '../../../orchestration/session/store-sync.js';
import type { OrchestrationStreamEvent } from '../../../orchestration/types.js';
import type { StreamFlushBuffer } from '../../chat-types';
import type { StreamHandlerContext } from './types';
import { flushCompletedLines } from './flush-utils';

type TokenEvent = Extract<OrchestrationStreamEvent, { type: 'token' }>;
type StartEvent = Extract<OrchestrationStreamEvent, { type: 'start' }>;

/** Handle a 'token' event: append token, emit header if first, flush completed lines. */
export function handleTokenEvent(event: TokenEvent, ctx: StreamHandlerContext): void {
  const participantId = ctx.idMap.get(event.agentId);
  if (!participantId) return;
  const placeholder = ctx.placeholders.get(participantId);
  if (!placeholder) return;

  ctx.markAgentStarted(event.agentId, participantId);
  appendToken(ctx.sessionId, placeholder.id, event.token);

  let buf = ctx.streamFlushRef.current.get(participantId);
  if (!buf) {
    buf = { messageId: placeholder.id, unflushed: '', chunkCounter: 0, headerEmitted: false, inCodeBlock: false, codeBlockAccum: '' } satisfies StreamFlushBuffer;
    ctx.streamFlushRef.current.set(participantId, buf);
  }

  if (!buf.headerEmitted) {
    buf.headerEmitted = true;
    const guidance = ctx.guidanceRef.current.get(participantId);
    ctx.setStaticEntries(prev => [
      ...prev,
      {
        id: `${placeholder.id}-hdr`,
        kind: 'stream-header' as const,
        senderId: participantId,
        ...(guidance ? { guidance } : {}),
      },
    ]);
  }

  buf.unflushed += event.token;
  flushCompletedLines(buf, placeholder.id, ctx.setStaticEntries);
}

/** Handle a 'start' event: record guidance and move from waiting → streaming.
 *  Moving the participant on 'start' (before the first token) separates the
 *  state transition from the Static header entry that handleTokenEvent adds,
 *  which prevents Ink ghost renders caused by simultaneous state + Static changes. */
export function handleStartEvent(event: StartEvent, ctx: StreamHandlerContext): void {
  const participantId = ctx.idMap.get(event.agentId);
  if (participantId) {
    if (event.guidance) {
      ctx.guidanceRef.current.set(participantId, event.guidance);
    }
    ctx.markAgentStarted(event.agentId, participantId);
  }
}
