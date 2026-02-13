/**
 * Conversation Compaction
 *
 * Summarizes overflow messages using a budget LLM to keep conversation
 * history within token/message limits.
 */

import type { ProviderConfig } from '../types.js';
import { debug } from '../../core/debug-logger.js';

/** In-memory cache keyed by hash of overflow texts. */
const compactionCache = new Map<string, string>();

function hashOverflow(texts: readonly string[]): string {
  // Simple hash for cache key — concatenate and take a deterministic fingerprint
  let hash = 0;
  const combined = texts.join('\n');
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `compact-${hash}`;
}

/**
 * Summarize overflow messages using a budget LLM.
 *
 * @param overflowTexts - Formatted conversation lines to summarize
 * @param summaryModel - Model ID to use (defaults to Ollama llama3.2)
 * @param summaryProvider - Provider config override
 * @returns Summary string, or undefined if summarization fails or input is empty
 */
export async function compactMessages(
  overflowTexts: readonly string[],
  summaryModel?: string,
  summaryProvider?: ProviderConfig,
): Promise<string | undefined> {
  if (overflowTexts.length === 0) return undefined;

  const cacheKey = hashOverflow(overflowTexts);
  const cached = compactionCache.get(cacheKey);
  if (cached) return cached;

  const prompt = `Summarize the following conversation excerpt in 2-3 concise sentences. Focus on key topics, decisions, and any code discussed:\n\n${overflowTexts.join('\n')}`;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let llm: any;
    const providerType = summaryProvider?.type ?? 'ollama';

    switch (providerType) {
      case 'openai': {
        const { ChatOpenAI } = await import('@langchain/openai');
        llm = new ChatOpenAI({ model: summaryModel ?? 'gpt-4o-mini' });
        break;
      }
      case 'anthropic': {
        const { ChatAnthropic } = await import('@langchain/anthropic');
        llm = new ChatAnthropic({ model: summaryModel ?? 'claude-haiku-4-5-20251001' });
        break;
      }
      case 'gemini': {
        const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
        llm = new ChatGoogleGenerativeAI({ model: summaryModel ?? 'gemini-2.0-flash' });
        break;
      }
      default: {
        // Default to Ollama (free, local)
        const { ChatOllama } = await import('@langchain/ollama');
        llm = new ChatOllama({ model: summaryModel ?? 'llama3.2' });
        break;
      }
    }

    const response = await llm.invoke(prompt);
    const content = typeof response.content === 'string' ? response.content : '';

    if (content.length > 0) {
      compactionCache.set(cacheKey, content);
      return content;
    }

    return undefined;
  } catch (err) {
    debug('compaction', 'summarization-failed', {
      error: err instanceof Error ? err.message : String(err),
      provider: summaryProvider?.type ?? 'ollama',
    });
    return undefined;
  }
}

/**
 * Clear the compaction cache (useful for testing or session reset).
 */
export function clearCompactionCache(): void {
  compactionCache.clear();
}
