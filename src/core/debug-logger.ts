import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ProviderRequestLog {
  requestId: string;
  model: string;
  messages: Array<{
    role: string;
    content: string;
    name?: string;
  }>;
  response: string;
  startTime: Date;
  endTime: Date;
  options?: Record<string, unknown>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cachedTokens?: number;
  };
  metadata?: Record<string, unknown>;
}

const LOG_DIR = join(process.cwd(), '.cebus');
const LOG_FILE = join(LOG_DIR, 'debug.log');
const CHAT_FILE = join(LOG_DIR, 'chat-transcript.md');

let isEnabled = false;
let sessionId = '';
let dirReady = false;
const initializedModelLogs = new Set<string>();

/**
 * Check if debug logging is enabled.
 * Unified check: CEBUS_DEBUG env, DEBUG env, or programmatic enablement.
 */
export function isDebugEnabled(): boolean {
  return isEnabled || process.env.CEBUS_DEBUG === 'true' || process.env.DEBUG === 'true';
}

function ensureLogDir(): void {
  if (dirReady) return;
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  dirReady = true;
}

function sanitizeForFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '\n...[truncated]';
}

function formatMetadataBlock(data: ProviderRequestLog, duration: number): string {
  let block = '```\n';
  block += `model            : ${data.model}\n`;
  block += `startTime        : ${data.startTime.toISOString()}\n`;
  block += `endTime          : ${data.endTime.toISOString()}\n`;
  block += `duration         : ${duration}ms\n`;
  block += `requestId        : ${data.requestId}\n`;

  if (data.usage) {
    block += `promptTokens     : ${data.usage.promptTokens ?? 'N/A'}\n`;
    block += `completionTokens : ${data.usage.completionTokens ?? 'N/A'}\n`;
    block += `totalTokens      : ${data.usage.totalTokens ?? 'N/A'}\n`;
    if (data.usage.cacheReadTokens !== undefined) {
      block += `cacheReadTokens  : ${data.usage.cacheReadTokens}\n`;
    }
    if (data.usage.cacheWriteTokens !== undefined) {
      block += `cacheWriteTokens : ${data.usage.cacheWriteTokens}\n`;
    }
    if (data.usage.cachedTokens !== undefined) {
      block += `cachedTokens     : ${data.usage.cachedTokens}\n`;
    }
  }

  if (data.options && Object.keys(data.options).length > 0) {
    block += `options          : ${JSON.stringify(data.options)}\n`;
  }

  if (data.metadata && Object.keys(data.metadata).length > 0) {
    for (const [key, value] of Object.entries(data.metadata)) {
      const paddedKey = key.padEnd(16, ' ');
      block += `${paddedKey} : ${typeof value === 'object' ? JSON.stringify(value) : value}\n`;
    }
  }

  block += '```\n\n';
  return block;
}

function getModelLogFile(provider: string, model: string): string {
  return join(LOG_DIR, `${sanitizeForFilename(provider)}--${sanitizeForFilename(model)}.md`);
}

export function enableDebugLogging(sid?: string): void {
  isEnabled = true;
  sessionId = sid ?? `session-${Date.now()}`;

  ensureLogDir();

  // Write session header
  writeFileSync(
    LOG_FILE,
    `\n${'='.repeat(80)}\n` +
      `Session: ${sessionId}\n` +
      `Started: ${new Date().toISOString()}\n` +
      `Node: ${process.version}\n` +
      `Platform: ${process.platform}\n` +
      `${'='.repeat(80)}\n\n`,
    { flag: 'a' }
  );

  log('info', 'logger', 'Debug logging enabled', { logFile: LOG_FILE });
}

export function log(
  level: LogLevel,
  category: string,
  message: string,
  data?: unknown
): void {
  if (!isDebugEnabled()) return;

  const timestamp = new Date().toISOString();

  const levelIcon = {
    debug: '🔍',
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌',
  }[level];

  let logLine = `[${timestamp}] ${levelIcon} [${category.toUpperCase()}] ${message}`;
  if (data !== undefined) {
    try {
      logLine += `\n  Data: ${JSON.stringify(data, null, 2).replace(/\n/g, '\n  ')}`;
    } catch {
      // Expected: data may contain circular references or non-serializable values
      logLine += `\n  Data: [Unable to serialize]`;
    }
  }
  logLine += '\n';

  try {
    appendFileSync(LOG_FILE, logLine);
  } catch {
    // Expected: logger must never crash the app — disk full, permissions, etc.
  }
}

export const debug = (category: string, message: string, data?: unknown): void =>
  log('debug', category, message, data);

export const info = (category: string, message: string, data?: unknown): void =>
  log('info', category, message, data);

export const warn = (category: string, message: string, data?: unknown): void =>
  log('warn', category, message, data);

export const error = (category: string, message: string, data?: unknown): void =>
  log('error', category, message, data);

export function logMessage(
  event: 'create' | 'update' | 'complete' | 'error' | 'stream',
  messageId: string,
  details?: unknown
): void {
  debug('message', `Message ${event}: ${messageId}`, details);
}

export function logRender(
  component: string,
  event: string,
  details?: unknown
): void {
  debug('render', `${component}: ${event}`, details);
}

export function logStream(
  participantId: string,
  event: 'start' | 'token' | 'complete' | 'error' | 'waiting',
  details?: unknown
): void {
  debug('stream', `${participantId}: ${event}`, details);
}

export function logSession(event: string, details?: unknown): void {
  info('session', event, details);
}

export function logProvider(
  provider: string,
  event: string,
  details?: unknown
): void {
  debug('provider', `${provider}: ${event}`, details);
}

export function logProviderRequest(
  provider: string,
  data: ProviderRequestLog
): void {
  if (!isDebugEnabled()) return;

  const modelLogFile = getModelLogFile(provider, data.model);
  const modelKey = `${provider}:${data.model}`;

  if (!initializedModelLogs.has(modelKey)) {
    initModelLog(data.model, provider);
    initializedModelLogs.add(modelKey);
  }

  ensureLogDir();

  const duration = data.endTime.getTime() - data.startTime.getTime();
  const shortId = data.requestId.substring(0, 8);

  let entry = `# ${shortId}\n\n`;

  entry += `## Request Messages\n\n`;
  for (const msg of data.messages) {
    const roleName = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    const nameTag = msg.name ? ` (${msg.name})` : '';
    entry += `### ${roleName}${nameTag}\n\n`;
    entry += `${truncate(msg.content, 2000)}\n\n`;
  }

  entry += `## Response\n\n### Assistant\n\n`;
  entry += `${truncate(data.response, 2000)}\n\n`;

  entry += `## Metadata\n\n`;
  entry += formatMetadataBlock(data, duration);
  entry += `---\n\n`;

  try {
    appendFileSync(modelLogFile, entry);
  } catch {
    // Expected: logger must never crash the app — disk full, permissions, etc.
  }

  debug('provider', `${provider}: request-complete`, {
    requestId: data.requestId,
    model: data.model,
    duration: `${duration}ms`,
    usage: data.usage,
  });
}

function initModelLog(model: string, provider: string): void {
  if (!isDebugEnabled()) return;

  ensureLogDir();

  const header = `# ${model} (${provider})

**Session Started:** ${new Date().toLocaleString()}
**Node:** ${process.version}
**Platform:** ${process.platform}

---

`;

  try {
    writeFileSync(getModelLogFile(provider, model), header);
  } catch {
    // Expected: logger must never crash the app — disk full, permissions, etc.
  }
}

export function logContext(
  sessionId: string,
  event: 'level-change' | 'refresh' | 'stale' | 'fresh' | 'included' | 'skipped',
  details?: unknown
): void {
  debug('context', `${sessionId}: ${event}`, details);
}

export function startChatTranscript(title?: string): void {
  if (!isDebugEnabled()) return;

  ensureLogDir();

  const header = `# Cebus Chat Transcript

**Session:** ${title ?? 'Untitled Session'}
**Date:** ${new Date().toLocaleString()}

---

`;

  try {
    writeFileSync(CHAT_FILE, header);
  } catch {
    // Expected: logger must never crash the app — disk full, permissions, etc.
  }
}

export function logChatMessage(
  sender: string,
  content: string,
  isUser: boolean = false
): void {
  if (!isDebugEnabled()) return;

  ensureLogDir();

  const timestamp = new Date().toLocaleTimeString();
  const icon = isUser ? '🧑' : '🤖';

  const entry = `### ${icon} ${sender} _(${timestamp})_

${content}

---

`;

  try {
    appendFileSync(CHAT_FILE, entry);
  } catch {
    // Expected: logger must never crash the app — disk full, permissions, etc.
  }
}
