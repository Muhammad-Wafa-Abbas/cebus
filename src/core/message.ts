import type {
  Message,
  MessageType,
  MessageStatus,
  CompletionMeta,
} from './types';
import { generateId } from './utils/id';

export interface CreateMessageOptions {
  sessionId: string;
  senderId: string;
  content: string;
  type?: MessageType | undefined;
  status?: MessageStatus | undefined;
  directedTo?: string[] | undefined;
  id?: string | undefined;
  timestamp?: number | undefined;
}

export function createMessage(options: CreateMessageOptions): Message {
  const type = options.type ?? 'user';
  const defaultStatus = type === 'user' ? 'sending' : 'streaming';

  return {
    id: options.id ?? generateId(),
    sessionId: options.sessionId,
    senderId: options.senderId,
    content: options.content,
    timestamp: options.timestamp ?? Date.now(),
    type,
    status: options.status ?? defaultStatus,
    directedTo: options.directedTo,
    completionMeta: undefined,
  };
}

export function createUserMessage(
  sessionId: string,
  senderId: string,
  content: string,
  directedTo?: string[],
): Message {
  return createMessage({
    sessionId,
    senderId,
    content,
    type: 'user',
    status: 'sending',
    directedTo,
  });
}

export function createAssistantMessage(
  sessionId: string,
  senderId: string,
  content: string = ''
): Message {
  return createMessage({
    sessionId,
    senderId,
    content,
    type: 'assistant',
    status: 'streaming',
  });
}

export function createSystemMessage(sessionId: string, content: string): Message {
  return createMessage({
    sessionId,
    senderId: 'system',
    content,
    type: 'system',
    status: 'sent',
  });
}

export function markMessageSent(message: Message): Message {
  return { ...message, status: 'sent' };
}

export function markMessageComplete(message: Message, meta?: CompletionMeta): Message {
  return { ...message, status: 'complete', completionMeta: meta };
}

export function markMessageError(message: Message, error: { code: string; message: string }): Message {
  return {
    ...message,
    status: 'error',
    completionMeta: { finishReason: 'error', error },
  };
}

export function appendMessageContent(message: Message, additionalContent: string): Message {
  return { ...message, content: message.content + additionalContent };
}

export function isModelMessage(message: Message): boolean {
  return message.type === 'assistant';
}

export function isUserMessage(message: Message): boolean {
  return message.type === 'user';
}

export function isDirectedMessage(message: Message): boolean {
  return Array.isArray(message.directedTo) && message.directedTo.length > 0;
}

export function isBroadcastMessage(message: Message): boolean {
  return !isDirectedMessage(message);
}

export function isMessageForParticipant(message: Message, participantId: string): boolean {
  if (isBroadcastMessage(message)) return true;
  return message.directedTo?.includes(participantId) ?? false;
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function getMessageAge(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
