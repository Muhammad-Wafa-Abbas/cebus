import { useEffect } from 'react';
import type { Message } from '../../core/types';
import { getMessages } from '../../core/session';
import { logStream, debug } from '../../core/debug-logger';

interface UseMessageRefreshParams {
  sessionId: string;
  streamingParticipants: string[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

/**
 * Refreshes messages every 100ms while participants are actively streaming.
 * Keeps the live area updated with partial content.
 */
export function useMessageRefresh({
  sessionId,
  streamingParticipants,
  setMessages,
}: UseMessageRefreshParams): void {
  useEffect(() => {
    if (streamingParticipants.length === 0) return;

    logStream('app', 'start', { streamingParticipants });

    const interval = setInterval(() => {
      const msgs = getMessages(sessionId);
      debug('app', 'Refresh interval', {
        messageCount: msgs.length,
        streamingCount: msgs.filter(m => m.status === 'streaming').length,
      });
      setMessages([...msgs]);
    }, 100);

    return () => {
      logStream('app', 'complete', { streamingParticipants });
      clearInterval(interval);
    };
  }, [sessionId, streamingParticipants]);
}
