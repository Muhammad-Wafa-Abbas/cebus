export * from './types';
export * from './registry';
export { createOpenAIAdapter, OpenAIAdapter } from './openai';
export { createAnthropicAdapter, AnthropicAdapter } from './anthropic';
export { createCopilotAdapter, CopilotAdapter, checkCopilotStatus } from './copilot';
export type { CopilotStatus } from './copilot';
export { createGeminiAdapter, GeminiAdapter } from './gemini';
export { createOllamaAdapter, OllamaAdapter } from './ollama';

import { getProviderRegistry } from './registry';
import { createOpenAIAdapter } from './openai';
import { createAnthropicAdapter } from './anthropic';
import { createCopilotAdapter } from './copilot';
import { createGeminiAdapter } from './gemini';
import { createOllamaAdapter } from './ollama';

/**
 * Register all built-in providers.
 */
export function registerBuiltInProviders(): void {
  const registry = getProviderRegistry();

  if (!registry.get('openai')) {
    registry.register(createOpenAIAdapter());
  }
  if (!registry.get('anthropic')) {
    registry.register(createAnthropicAdapter());
  }
  if (!registry.get('copilot')) {
    registry.register(createCopilotAdapter());
  }
  if (!registry.get('gemini')) {
    registry.register(createGeminiAdapter());
  }
  if (!registry.get('ollama')) {
    registry.register(createOllamaAdapter());
  }
}

/**
 * Initialize all available providers.
 */
export async function initializeProviders(): Promise<void> {
  registerBuiltInProviders();
  const registry = getProviderRegistry();
  await registry.initializeAll();
}

interface ProviderStatusInfo {
  id: string;
  name: string;
  available: boolean;
  reason?: string;
}

/**
 * Check the status of all registered providers.
 * Returns information about which providers are available and why others aren't.
 */
async function checkAllProvidersStatus(): Promise<ProviderStatusInfo[]> {
  registerBuiltInProviders();
  const registry = getProviderRegistry();
  const providers = registry.getAll();
  const results: ProviderStatusInfo[] = [];

  for (const provider of providers) {
    const info: ProviderStatusInfo = {
      id: provider.id,
      name: provider.displayName,
      available: false,
    };

    try {
      const isAvailable = await provider.isAvailable();
      if (isAvailable) {
        await provider.initialize();
        info.available = true;
        await provider.dispose();
      } else {
        info.reason = getUnavailableReason(provider.id);
      }
    } catch (error) {
      info.reason = error instanceof Error ? error.message : 'Unknown error';
    }

    results.push(info);
  }

  return results;
}

/**
 * Get the reason why a provider is unavailable based on its ID.
 */
function getUnavailableReason(providerId: string): string {
  switch (providerId) {
    case 'openai':
      return 'OPENAI_API_KEY not set';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY not set';
    case 'gemini':
      return 'GOOGLE_API_KEY not set';
    case 'copilot':
      return 'Copilot CLI not installed. Run: npm i -g @githubnext/github-copilot-cli && github-copilot-cli auth';
    case 'ollama':
      return 'Ollama not running. Install: https://ollama.com and run: ollama serve';
    default:
      return 'Not configured';
  }
}

/**
 * Print provider status to console.
 */
export async function printProviderStatus(): Promise<void> {
  const statuses = await checkAllProvidersStatus();

  console.log('\nProvider Status:');
  for (const status of statuses) {
    const icon = status.available ? '✓' : '✗';
    const color = status.available ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    if (status.available) {
      console.log(`  ${color}${icon}${reset} ${status.name}: Ready`);
    } else {
      console.log(`  ${color}${icon}${reset} ${status.name}: ${status.reason}`);
    }
  }
  console.log();
}
