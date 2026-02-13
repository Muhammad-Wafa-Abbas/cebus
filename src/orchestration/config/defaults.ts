/**
 * Orchestration Configuration Defaults
 *
 * Loads prompt files from .cebus/prompts/ at runtime.
 * Edit the .md files to change model behavior — no rebuild needed.
 *
 * Resolution order:
 * 1. .cebus/prompts/{path} (relative to cwd — primary)
 * 2. {packageDir}/.cebus/prompts/{path} (relative to this module — works after npm install)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChatMode } from '../../core/types.js';
import type { CostTier } from '../../core/model-tiers.js';

const _promptCache = new Map<string, string>();

const FALLBACK_PROMPT = `You are participating in a group chat with a user and other AI models.
Respond naturally and concisely. Don't prefix your response with your name.`;

/** Directory containing this module (works in both dev and installed contexts). */
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load a prompt file by relative path under the prompts/ directory.
 * Cached after first read. Returns empty string if file is missing.
 */
function loadPromptFile(relativePath: string): string {
  const cached = _promptCache.get(relativePath);
  if (cached !== undefined) return cached;

  const searchPaths = [
    // Primary: .cebus/prompts/ relative to cwd
    resolve(process.cwd(), '.cebus/prompts', relativePath),
    // Installed: __dirname = dist/orchestration/config/ → up 3 to package root → .cebus/prompts/
    resolve(__dirname, '..', '..', '..', '.cebus', 'prompts', relativePath),
  ];

  for (const promptPath of searchPaths) {
    try {
      const content = readFileSync(promptPath, 'utf-8').trim();
      _promptCache.set(relativePath, content);
      return content;
    } catch {
      // Try next path
    }
  }

  _promptCache.set(relativePath, '');
  return '';
}

/**
 * Load the default system prompt from the .md file.
 * Cached after first read. Falls back to a minimal prompt if file is missing.
 */
export function getDefaultSystemPrompt(): string {
  const loaded = loadPromptFile('system.md');
  return loaded || FALLBACK_PROMPT;
}

/** Map ChatMode enum values to prompt file slugs. */
const MODE_SLUG: Record<ChatMode, string> = {
  free_chat: 'free-chat',
  sequential: 'sequential',
  tag_only: 'tag-only',
  role_based: 'role-based',
};

/**
 * Load chat-mode-specific instructions.
 * Returns empty string if the mode file doesn't exist.
 */
export function getModePrompt(mode: ChatMode): string {
  const slug = MODE_SLUG[mode];
  return loadPromptFile(`modes/${slug}.md`);
}

/**
 * Load cost-tier-specific model guidance.
 * Returns empty string if the tier file doesn't exist.
 */
export function getTierPrompt(tier: CostTier): string {
  return loadPromptFile(`tiers/${tier}.md`);
}

/**
 * Load an orchestrator prompt file.
 * Returns empty string if the file doesn't exist.
 */
export function loadOrchestratorPrompt(filename: string): string {
  return loadPromptFile(`orchestrator/${filename}`);
}

