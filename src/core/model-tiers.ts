import type { ModelInfo } from '../providers/types';

export type CostTier = 'budget' | 'middle' | 'premium' | 'local';

export interface TieredModel {
  providerId: string;
  model: ModelInfo;
  tier: CostTier;
  priority: number;
}

const PREMIUM_KEYWORDS = [
  'opus',      // All Opus models are premium (covers 4, 4.1, 4.5, 4.6, etc.)
  'gpt-5.2',
  'GPT-5.2',
  'gpt-5.1',
  'gpt-4.1',
  '-pro-',
  '-pro',
  'codex',

  ':70b',
  ':72b',
  ':120b',
  ':180b',
  ':405b',
  '-70b',
  '-72b',
  '-120b',
  '-180b',
  '-405b',
];

const BUDGET_KEYWORDS = [
  'haiku',
  'mini',
  'nano',
  '3-flash',

  'phi',
  'tinyllama',
  ':0.5b',
  ':1b',
  ':1.5b',
  ':2b',
  ':3b',
  '-0.5b',
  '-1b',
  '-1.5b',
  '-2b',
  '-3b',
];

const MODEL_PRIORITY: Record<string, number> = {
  'claude-opus-4-6': 1,
  'claude-opus-4.6': 1,
  'gpt-5.2': 2,
  'GPT-5.2-Codex': 2,
  'gpt-5.1': 3,
  'gpt-5.1-codex': 3,
  'claude-opus-4-5-20251101': 4,
  'claude-opus-4.5': 4,
  'gpt-4.1': 5,
  'claude-sonnet-4-5-20250929': 6,
  'claude-sonnet-4.5': 6,
  'gemini-3-pro-preview': 7,
  'gemini-2.5-pro': 8,

  'llama3.3:70b': 9,
  'qwen2.5:72b': 9,
  'mixtral:8x22b': 9,

  'claude-sonnet-4-20250514': 10,
  'gemini-2.5-flash': 11,
  'gemini-2.0-flash': 13,

  'llama3.3:latest': 14,
  'llama3.2:latest': 14,
  'qwen2.5:latest': 14,
  'qwen2.5:7b': 14,
  'qwen2.5:14b': 15,
  'mistral:latest': 15,
  'mixtral:latest': 15,
  'gemma2:latest': 15,
  'codellama:latest': 16,
  'deepseek-coder:latest': 16,

  'claude-haiku-4-5-20251001': 20,
  'gpt-4.1-mini': 21,
  'gemini-3-flash-preview': 22,

  'phi:latest': 25,
  'phi3:latest': 25,
  'gemma2:2b': 25,
  'tinyllama:latest': 26,
};

function extractModelSize(modelId: string): number {
  const match = modelId.match(/[:\-](\d+)b/i);
  return match?.[1] ? parseInt(match[1], 10) : 0;
}

export function getModelTier(modelId: string): CostTier {
  const lowerModelId = modelId.toLowerCase();

  if (PREMIUM_KEYWORDS.some(keyword => lowerModelId.includes(keyword))) {
    return 'premium';
  }

  if (BUDGET_KEYWORDS.some(keyword => lowerModelId.includes(keyword))) {
    return 'budget';
  }

  return 'middle';
}

export function getModelPriority(modelId: string): number {
  return MODEL_PRIORITY[modelId] ?? 999;
}

export function categorizeModels(
  providerModels: Array<{ providerId: string; providerName: string; models: ModelInfo[] }>
): TieredModel[] {
  const tiered: TieredModel[] = [];
  const seenModels = new Set<string>();

  for (const provider of providerModels) {
    for (const model of provider.models) {
      const modelKey = `${provider.providerId}:${model.id}`;

      if (seenModels.has(modelKey)) {
        continue;
      }
      seenModels.add(modelKey);

      tiered.push({
        providerId: provider.providerId,
        model,
        tier: provider.providerId === 'ollama' ? 'local' : getModelTier(model.id),
        priority: getModelPriority(model.id),
      });
    }
  }

  tiered.sort((a, b) => {
    const tierOrder: Record<CostTier, number> = { premium: 0, middle: 1, budget: 2, local: 3 };
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;

    return a.priority - b.priority;
  });

  return tiered;
}

export function filterModelsByTier(
  models: TieredModel[],
  preference: CostTier
): TieredModel[] {
  const filtered = models.filter(m => {
    switch (preference) {
      case 'local':
        return m.providerId === 'ollama';

      case 'premium':
        return m.providerId !== 'ollama' && (m.tier === 'premium' || m.tier === 'middle');

      case 'middle':
        return m.providerId !== 'ollama';

      case 'budget':
        return m.providerId === 'ollama' || m.tier === 'budget' || m.tier === 'middle';

      default:
        return true;
    }
  });

  return filtered.sort((a, b) => {
    if (preference === 'budget') {
      const aIsLocal = a.providerId === 'ollama';
      const bIsLocal = b.providerId === 'ollama';
      if (aIsLocal && !bIsLocal) return -1;
      if (!aIsLocal && bIsLocal) return 1;

      if (aIsLocal && bIsLocal) {
        const aSize = extractModelSize(a.model.id);
        const bSize = extractModelSize(b.model.id);
        if (aSize !== bSize) return aSize - bSize;
        return a.model.id.localeCompare(b.model.id);
      }

      return b.priority - a.priority;
    }

    const aTierMatch = a.tier === preference ? 0 : 1;
    const bTierMatch = b.tier === preference ? 0 : 1;
    if (aTierMatch !== bTierMatch) return aTierMatch - bTierMatch;

    const tierOrder: Record<CostTier, number> = { premium: 0, middle: 1, budget: 2, local: 3 };
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;

    if (preference === 'local' && a.providerId === 'ollama' && b.providerId === 'ollama') {
      const aSize = extractModelSize(a.model.id);
      const bSize = extractModelSize(b.model.id);
      if (aSize !== bSize) return aSize - bSize;
      return a.model.id.localeCompare(b.model.id);
    }

    return a.priority - b.priority;
  });
}

export function getTierLabel(tier: CostTier): string {
  switch (tier) {
    case 'local':
      return 'Free (Local Models)';
    case 'budget':
      return 'Lowest Cost (Budget)';
    case 'middle':
      return 'Medium Cost (Balanced)';
    case 'premium':
      return 'Highest Cost (Premium)';
  }
}

export function getTierEmoji(tier: CostTier): string {
  switch (tier) {
    case 'local':
      return '🏠';
    case 'premium':
      return '💎';
    case 'middle':
      return '⚖️ ';
    case 'budget':
      return '💰';
  }
}

/**
 * Get the recommended history window (message count) for a given cost tier.
 * Budget/local models get fewer messages to reduce costs; premium get more for richer context.
 */
export function getTierHistoryWindow(tier: CostTier): number {
  switch (tier) {
    case 'budget':
    case 'local':
      return 10;
    case 'middle':
      return 20;
    case 'premium':
      return 40;
  }
}

/**
 * Get the recommended token budget for history windowing per tier.
 * Used by trimMessages when maxHistoryMessages is not set.
 */
export function getTierTokenBudget(tier: CostTier): number {
  switch (tier) {
    case 'budget':
    case 'local':
      return 4096;
    case 'middle':
      return 8192;
    case 'premium':
      return 16384;
  }
}

/**
 * Rough token estimate: ~4 characters per token (ceiling).
 * Used for lightweight token counting without a full tokenizer.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
