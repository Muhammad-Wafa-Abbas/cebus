/**
 * Shared content formatting for provider adapters.
 */

/**
 * Extract string content from message content (for system messages or text-only APIs).
 */
export function getTextContent(content: string): string {
  return content;
}
