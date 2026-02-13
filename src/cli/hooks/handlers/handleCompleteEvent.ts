/**
 * Handle 'complete' and 'error' stream events.
 *
 * Flushes remaining buffer content, finalizes the message in the store,
 * and updates streaming state.
 */

import { getMessages } from '../../../core/session';
import { logMessage, logChatMessage } from '../../../core/debug-logger';
import {
  finalizeResponse,
  finalizeError,
} from '../../../orchestration/session/store-sync.js';
import type { OrchestrationStreamEvent } from '../../../orchestration/types.js';
import type { StreamHandlerContext } from './types';
import { flushRemaining } from './flush-utils';

type CompleteEvent = Extract<OrchestrationStreamEvent, { type: 'complete' }>;
type ErrorEvent = Extract<OrchestrationStreamEvent, { type: 'error' }>;

/** Handle a 'complete' event: flush remaining, finalize in store, update state. */
export function handleCompleteEvent(event: CompleteEvent, ctx: StreamHandlerContext): void {
  const participantId = ctx.idMap.get(event.agentId);
  if (participantId) {
    const placeholder = ctx.placeholders.get(participantId);
    if (placeholder) {
      const buf = ctx.streamFlushRef.current.get(participantId);
      if (buf) {
        flushRemaining(buf, placeholder.id, ctx.setStaticEntries);
      }
      ctx.streamFlushRef.current.delete(participantId);
      ctx.streamingMessageIds.current.delete(placeholder.id);
      ctx.staticIds.current.add(placeholder.id);

      const completeMsg = finalizeResponse(ctx.sessionId, placeholder.id, {
        agentId: event.agentId,
        agentName: event.agentId,
        content: event.content,
        toolInvocations: [],
        ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}),
      });
      ctx.modelResponseCount.current += 1;
      logMessage('complete', participantId, { responseCount: ctx.modelResponseCount.current });
      const sender = ctx.participants.find(p => p.id === participantId);
      logChatMessage(sender?.displayName ?? 'Model', completeMsg.content, false);
    }
    ctx.setStreamingParticipants(prev => prev.filter(id => id !== participantId));
    ctx.setWaitingParticipants(prev => prev.filter(id => id !== participantId));
  }
  ctx.setMessages([...getMessages(ctx.sessionId)]);
}

/** Handle an 'error' event: finalize error in store, remove from streaming. */
export function handleErrorEvent(event: ErrorEvent, ctx: StreamHandlerContext): void {
  const participantId = ctx.idMap.get(event.agentId);
  if (participantId) {
    const placeholder = ctx.placeholders.get(participantId);
    if (placeholder) {
      ctx.streamingMessageIds.current.delete(placeholder.id);

      if (event.error.code === 'CANCELLED') {
        // Graceful cancel — flush any partial content and finalize with what was streamed
        const buf = ctx.streamFlushRef.current.get(participantId);
        if (buf) {
          flushRemaining(buf, placeholder.id, ctx.setStaticEntries);
        }
        ctx.streamFlushRef.current.delete(participantId);
        ctx.staticIds.current.add(placeholder.id);
        // Finalize as a completed message with partial content + "(cancelled)" suffix
        const current = getMessages(ctx.sessionId).find(m => m.id === placeholder.id);
        const partialContent = current?.content ?? '';
        const cancelledContent = partialContent.length > 0
          ? `${partialContent}\n\n_(cancelled)_`
          : '_(cancelled)_';
        finalizeResponse(ctx.sessionId, placeholder.id, {
          agentId: event.agentId,
          agentName: event.agentId,
          content: cancelledContent,
          toolInvocations: [],
        });
      } else {
        finalizeError(ctx.sessionId, placeholder.id, event.error.code, event.error.message);
      }
    }
    logMessage('error', participantId, { error: event.error, cancelled: event.error.code === 'CANCELLED' });
    ctx.setStreamingParticipants(prev => prev.filter(id => id !== participantId));
    ctx.setWaitingParticipants(prev => prev.filter(id => id !== participantId));
  }
  ctx.setMessages([...getMessages(ctx.sessionId)]);
}
