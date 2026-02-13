/**
 * ModelSelectionStep — multi-select list of AI models grouped by provider.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getTierEmoji, getTierLabel } from '../../../core/model-tiers';
import { rebuildAvailableModels, getTotalProviderModels } from './model-filters';
import type { OnboardingAction, OnboardingState } from './types';

const DEFAULT_VISIBLE = 3;
const EXPAND_STEP = 3;

export interface ModelSelectionStepProps {
  state: OnboardingState;
  dispatch: (action: OnboardingAction) => void;
  isActive: boolean;
}

export function ModelSelectionStep({ state, dispatch, isActive }: ModelSelectionStepProps): React.ReactElement {
  const [focusIndex, setFocusIndex] = useState(0);

  const { availableModels, selectedSpecs, costPreference, expandedProviders, allModels, error } = state;

  function toggleShowMore(providerId: string): void {
    const total = getTotalProviderModels(allModels, costPreference, providerId);
    const currentLimit = expandedProviders.get(providerId) ?? DEFAULT_VISIBLE;

    const newExpanded = new Map(expandedProviders);
    if (currentLimit >= total) {
      // All shown — collapse back to default
      newExpanded.delete(providerId);
    } else {
      // Show more
      newExpanded.set(providerId, Math.min(currentLimit + EXPAND_STEP, total));
    }

    dispatch({ type: 'setExpandedProviders', value: newExpanded });

    const focusedSpec = availableModels[focusIndex]?.spec;
    const rebuilt = rebuildAvailableModels(allModels, costPreference, newExpanded);
    dispatch({ type: 'setAvailableModels', value: rebuilt });

    if (focusedSpec) {
      const newIndex = rebuilt.findIndex(m => m.spec === focusedSpec);
      if (newIndex >= 0) {
        setFocusIndex(newIndex);
      }
    }
  }

  useInput((input, key) => {
    if (!isActive) return;

    if (key.escape) {
      dispatch({ type: 'goBack' });
      return;
    }
    if (key.upArrow) {
      setFocusIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setFocusIndex(prev => Math.min(availableModels.length - 1, prev + 1));
    } else if (input === ' ') {
      const currentModel = availableModels[focusIndex];
      if (currentModel) {
        const next = new Set(selectedSpecs);
        if (next.has(currentModel.spec)) {
          next.delete(currentModel.spec);
        } else {
          next.add(currentModel.spec);
        }
        dispatch({ type: 'setSelectedSpecs', value: next });
      }
    } else if (input === 'm') {
      const currentModel = availableModels[focusIndex];
      if (currentModel) {
        toggleShowMore(currentModel.provider);
      }
    } else if (input.toLowerCase() === 'a') {
      if (selectedSpecs.size === availableModels.length) {
        dispatch({ type: 'setSelectedSpecs', value: new Set() });
      } else {
        dispatch({ type: 'setSelectedSpecs', value: new Set(availableModels.map(m => m.spec)) });
      }
    } else if (key.return) {
      if (selectedSpecs.size === 0) {
        dispatch({ type: 'setError', value: 'Please select at least one model' });
        return;
      }
      dispatch({ type: 'goToStep', step: 'select-mode' });
    }
  }, { isActive });

  // Group models by provider
  const byProvider = new Map<string, typeof availableModels>();
  for (const model of availableModels) {
    if (!byProvider.has(model.provider)) {
      byProvider.set(model.provider, []);
    }
    byProvider.get(model.provider)!.push(model);
  }

  function hasMoreModels(providerId: string): boolean {
    const total = getTotalProviderModels(allModels, costPreference, providerId);
    const currentCount = availableModels.filter(m => m.provider === providerId).length;
    return total > currentCount;
  }

  function isFullyExpanded(providerId: string): boolean {
    const total = getTotalProviderModels(allModels, costPreference, providerId);
    const currentCount = availableModels.filter(m => m.provider === providerId).length;
    return currentCount >= total;
  }

  let globalIndex = 0;

  const tierCounts = {
    premium: availableModels.filter(m => m.tier === 'premium').length,
    middle: availableModels.filter(m => m.tier === 'middle').length,
    budget: availableModels.filter(m => m.tier === 'budget').length,
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Select AI Models  {getTierEmoji(costPreference)}
        </Text>
        <Text dimColor> ({getTierLabel(costPreference)})</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          {'Showing: \uD83D\uDC8E'}{tierCounts.premium} {'\u2696\uFE0F'}{tierCounts.middle} {'\uD83D\uDCB0'}{tierCounts.budget} models
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          ↑↓ navigate • Space select • A select all • M show more • Enter confirm • Esc back
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {Array.from(byProvider.entries()).map(([provider, models]) => (
          <Box key={provider} flexDirection="column" marginBottom={1}>
            <Text bold color="cyan">
              {provider.toUpperCase()}
            </Text>

            {models.map(model => {
              const index = globalIndex++;
              const isFocused = index === focusIndex;
              const isSelected = selectedSpecs.has(model.spec);
              const tierEmoji = getTierEmoji(model.tier);
              const isPreferredTier = model.tier === costPreference;

              return (
                <Box key={model.spec}>
                  {isFocused ? <Text color="yellow">{'❯ '}</Text> : <Text>{' '}</Text>}
                  <Text color={isSelected ? 'green' : 'white'}>{isSelected ? '◉ ' : '○ '}</Text>
                  <Text bold={isSelected}>{model.displayName}</Text>
                  <Text dimColor> @{model.nickname}</Text>
                  {!isPreferredTier && <Text dimColor>  {tierEmoji}</Text>}
                </Box>
              );
            })}

            {hasMoreModels(provider) && (
              <Box paddingLeft={2}>
                <Text dimColor italic>
                  ... press M to show more
                </Text>
              </Box>
            )}
            {isFullyExpanded(provider) && (expandedProviders.get(provider) ?? DEFAULT_VISIBLE) > DEFAULT_VISIBLE && (
              <Box paddingLeft={2}>
                <Text dimColor italic>
                  press M to collapse
                </Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>

      <Box>
        <Text dimColor>
          Selected: {selectedSpecs.size} model{selectedSpecs.size !== 1 ? 's' : ''}
        </Text>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="redBright" bold>
            {error}
          </Text>
        </Box>
      )}
    </Box>
  );
}
