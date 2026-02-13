import type { ChatMode } from '../../core/types';

/** Maximum icon width across all providers (for alignment). */
export const MAX_ICON_WIDTH = 2;

/** Provider-specific colors and icons for message rendering. */
export const PROVIDER_STYLES: Record<string, { color: string; icon: string; iconWidth: number }> = {
  anthropic: { color: '#d77b5c', icon: '✨', iconWidth: 2 },
  openai: { color: '#0f9d7d', icon: '🟢', iconWidth: 2 },
  copilot: { color: '#ca76cd', icon: '🤖', iconWidth: 2 },
  gemini: { color: '#4285F4', icon: '💎', iconWidth: 2 },
  default: { color: 'cyan', icon: '🔵', iconWidth: 2 },
};

export const USER_COLOR = 'blue';
export const USER_ICON = '👤';
export const USER_ICON_WIDTH = 2;

/** Padding for content: max icon width + 1 space between icon and name. */
export const CONTENT_PADDING = MAX_ICON_WIDTH + 1;

/** Orchestrator style — magenta diamond icon. */
export const ORCHESTRATOR_STYLE = { color: 'magenta', icon: '🔮', iconWidth: 2 };

/** Chat mode display labels. */
export const CHAT_MODE_LABELS: Record<ChatMode, string> = {
  free_chat: 'All at Once',
  sequential: 'One by One',
  tag_only: 'Mention Only',
  role_based: 'Role-Based',
};

/** Format token count for compact display (e.g. 1.5K, 2.3M). */
export function formatTokens(tokens: number): string {
  if (tokens === 0) return '0';
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return tokens.toLocaleString();
}
