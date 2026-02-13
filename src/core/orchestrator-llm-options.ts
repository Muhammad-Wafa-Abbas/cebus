/**
 * Orchestrator LLM Discovery
 *
 * Discovers models suitable for orchestrator middleware duty.
 * Includes: ALL Ollama chat models (free, local), all cloud tiers, and Copilot models.
 * Excludes: Embedding/non-chat models.
 */

import { getProviderRegistry, initializeProviders } from '../providers/index.js';
import { getModelTier, type CostTier } from './model-tiers.js';

export interface OrchestratorLLMOption {
  spec: string;          // "providerId:modelId"
  displayName: string;
  provider: string;
  tier: CostTier;
  isDefault: boolean;    // true for ollama:llama3.2
}

const DEFAULT_SPEC = 'ollama:llama3.2';

/**
 * Keywords that indicate a model is NOT a chat model (embedding, reranking, etc.).
 * These are filtered out from orchestrator options.
 */
const NON_CHAT_KEYWORDS = [
  'embed', 'minilm', 'bge-', 'rerank', 'snowflake-arctic-embed',
  'dall-e', 'whisper', 'tts', 'moderation',
  'deep-research', 'computer-use', 'realtime', 'audio',
  'chatgpt-image', 'search-preview',
] as const;

/** Tier labels for display */
const TIER_LABELS: Record<CostTier, string> = {
  local: 'free',
  budget: 'budget',
  middle: 'mid',
  premium: 'premium',
};

/**
 * Discover models eligible for orchestrator duty.
 * Returns sorted list: default first → local → budget → middle → premium.
 */
export async function discoverOrchestratorLLMOptions(): Promise<OrchestratorLLMOption[]> {
  await initializeProviders();
  const registry = getProviderRegistry();
  const providers = await registry.getAvailable();

  const options: OrchestratorLLMOption[] = [];

  for (const provider of providers) {
    const models = await provider.listModels();

    for (const model of models) {
      // Filter out non-chat models (embeddings, image gen, etc.)
      const lowerModelId = model.id.toLowerCase();
      if (NON_CHAT_KEYWORDS.some(kw => lowerModelId.includes(kw))) continue;

      const isLocal = provider.id === 'ollama';
      const tier = isLocal ? 'local' : getModelTier(model.id);

      const spec = `${provider.id}:${model.id}`;
      const tierLabel = TIER_LABELS[isLocal ? 'local' : tier];
      options.push({
        spec,
        displayName: `${model.displayName} [${tierLabel}]`,
        provider: provider.id,
        tier: isLocal ? 'local' : tier,
        isDefault: spec === DEFAULT_SPEC,
      });
    }
  }

  // Sort: default first → local → budget → middle → premium
  const tierOrder: Record<CostTier, number> = { local: 0, budget: 1, middle: 2, premium: 3 };
  options.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return a.displayName.localeCompare(b.displayName);
  });

  return options;
}
