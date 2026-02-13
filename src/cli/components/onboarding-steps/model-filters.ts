import { filterModelsByTier, type CostTier, type TieredModel } from '../../../core/model-tiers';
import type { AvailableModel } from './types';
import type { OrchestratorLLMOption } from '../../../core/orchestrator-llm-options';

const DEFAULT_VISIBLE = 3;

/**
 * Get all models for a provider: tier-matched models first, then remaining
 * models from the full list. This ensures at least DEFAULT_VISIBLE and
 * allows M-key expansion to reveal the full catalog.
 */
function getProviderModels(
  allModels: TieredModel[],
  tier: CostTier,
  providerId: string,
): TieredModel[] {
  const filtered = filterModelsByTier(allModels, tier).filter(m => m.providerId === providerId);

  const sortFn = (a: TieredModel, b: TieredModel): number => {
    const aTierMatch = a.tier === tier ? 0 : 1;
    const bTierMatch = b.tier === tier ? 0 : 1;
    if (aTierMatch !== bTierMatch) return aTierMatch - bTierMatch;
    return tier === 'budget' ? b.priority - a.priority : a.priority - b.priority;
  };

  filtered.sort(sortFn);

  // Append remaining models from full list (non-tier-matched) so M can reveal them
  if (tier !== 'local') {
    const filteredIds = new Set(filtered.map(m => m.model.id));
    const extras = allModels
      .filter(m => m.providerId === providerId && !filteredIds.has(m.model.id))
      .sort(sortFn);
    filtered.push(...extras);
  }

  return filtered;
}

export interface ApplyTierFilterResult {
  models: AvailableModel[];
  defaultSelections: string[];
}

export function applyTierFilter(allModels: TieredModel[], tier: CostTier): ApplyTierFilterResult {
  const filtered = filterModelsByTier(allModels, tier);

  // Collect unique provider IDs (preserving order)
  const providerIds: string[] = [];
  const seen = new Set<string>();
  for (const m of filtered) {
    if (!seen.has(m.providerId)) {
      seen.add(m.providerId);
      providerIds.push(m.providerId);
    }
  }
  // Also include providers that only appear after supplementing
  for (const m of allModels) {
    if (!seen.has(m.providerId)) {
      seen.add(m.providerId);
      providerIds.push(m.providerId);
    }
  }

  const models: AvailableModel[] = [];
  const defaultSelections: string[] = [];
  const seenSpecs = new Set<string>();

  for (const providerId of providerIds) {
    const providerModels = getProviderModels(allModels, tier, providerId);
    const limit = tier === 'local' ? providerModels.length : DEFAULT_VISIBLE;
    const visibleModels = providerModels.slice(0, limit);
    const firstModel = visibleModels[0];

    for (const tieredModel of visibleModels) {
      const spec = `${tieredModel.providerId}:${tieredModel.model.id}`;
      if (seenSpecs.has(spec)) continue;
      seenSpecs.add(spec);

      models.push({
        spec,
        displayName: tieredModel.model.displayName,
        provider: tieredModel.providerId,
        nickname: tieredModel.model.defaultNickname,
        tier: tieredModel.tier,
      });
    }

    if (tier === 'local') {
      // Will add all specs after building the full list
    } else {
      if (firstModel) {
        const firstSpec = `${firstModel.providerId}:${firstModel.model.id}`;
        defaultSelections.push(firstSpec);
      }
    }
  }

  if (tier === 'local') {
    for (const model of models) {
      defaultSelections.push(model.spec);
    }
  }

  return { models, defaultSelections };
}

export function rebuildAvailableModels(
  allModels: TieredModel[],
  costPreference: CostTier,
  expanded: Map<string, number>,
): AvailableModel[] {
  const filtered = filterModelsByTier(allModels, costPreference);

  const providerIds: string[] = [];
  const seen = new Set<string>();
  for (const m of filtered) {
    if (!seen.has(m.providerId)) {
      seen.add(m.providerId);
      providerIds.push(m.providerId);
    }
  }
  for (const m of allModels) {
    if (!seen.has(m.providerId)) {
      seen.add(m.providerId);
      providerIds.push(m.providerId);
    }
  }

  const models: AvailableModel[] = [];
  const seenSpecs = new Set<string>();

  for (const provider of providerIds) {
    const providerModels = getProviderModels(allModels, costPreference, provider);
    const limit =
      costPreference === 'local'
        ? providerModels.length
        : expanded.get(provider) ?? DEFAULT_VISIBLE;
    const visibleModels = providerModels.slice(0, limit);

    for (const tieredModel of visibleModels) {
      const spec = `${tieredModel.providerId}:${tieredModel.model.id}`;
      if (seenSpecs.has(spec)) continue;
      seenSpecs.add(spec);

      models.push({
        spec,
        displayName: tieredModel.model.displayName,
        provider: tieredModel.providerId,
        nickname: tieredModel.model.defaultNickname,
        tier: tieredModel.tier,
      });
    }
  }

  return models;
}

/** Total models available for a provider (including supplemented ones). */
export function getTotalProviderModels(
  allModels: TieredModel[],
  costPreference: CostTier,
  providerId: string,
): number {
  return getProviderModels(allModels, costPreference, providerId).length;
}

export function rebuildOrchestratorOptions(
  allOptions: OrchestratorLLMOption[],
  expanded: Set<string>,
): OrchestratorLLMOption[] {
  const byProvider = new Map<string, OrchestratorLLMOption[]>();
  for (const option of allOptions) {
    if (!byProvider.has(option.provider)) {
      byProvider.set(option.provider, []);
    }
    byProvider.get(option.provider)!.push(option);
  }

  const visible: OrchestratorLLMOption[] = [];
  for (const [provider, providerOptions] of byProvider) {
    const limit = expanded.has(provider) ? providerOptions.length : 3;
    visible.push(...providerOptions.slice(0, limit));
  }

  return visible;
}

export function hasMoreOrchestratorModels(
  allOptions: OrchestratorLLMOption[],
  visibleOptions: OrchestratorLLMOption[],
  providerId: string,
): boolean {
  const allCount = allOptions.filter(o => o.provider === providerId).length;
  const visibleCount = visibleOptions.filter(o => o.provider === providerId).length;
  return allCount > visibleCount;
}
