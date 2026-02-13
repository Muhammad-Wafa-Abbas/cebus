/**
 * Worker Factory
 *
 * T010: Worker contract definitions.
 * T017: Factory function routing to LangChain or Copilot worker.
 */

import type {
  AgentProfile,
  WorkerExecutor,
  OrchestrationLogger,
} from '../types.js';
import { OrchestrationError } from '../types.js';
import { LangChainWorker } from './langchain-worker.js';

/**
 * Create a worker executor based on the agent's provider type.
 *
 * - openai, anthropic, gemini, ollama → LangChainWorker
 * - copilot → CopilotWorker (dynamic import, optional peer dependency)
 */
export async function createWorker(
  profile: AgentProfile,
  logger?: OrchestrationLogger,
): Promise<WorkerExecutor> {
  const providerType = profile.provider?.type ?? 'openai';

  switch (providerType) {
    case 'openai':
    case 'anthropic':
    case 'gemini':
    case 'ollama':
      return new LangChainWorker(profile, logger);

    case 'copilot': {
      try {
        const { CopilotWorker } = await import('./copilot-worker.js');
        const worker = new CopilotWorker(profile, logger);
        // Restore saved session ID for zero-cost SDK resume
        if (profile.copilotSessionId) {
          worker.setSessionId(profile.copilotSessionId);
        }
        return worker;
      } catch {
        throw new OrchestrationError(
          'CONFIG_VALIDATION',
          `Copilot provider requires @github/copilot-sdk. Install it with: npm install @github/copilot-sdk`,
        );
      }
    }

    default:
      throw new OrchestrationError(
        'CONFIG_VALIDATION',
        `Unknown provider type: ${providerType}. Valid types: openai, anthropic, gemini, ollama, copilot`,
      );
  }
}
