/**
 * CostPreferenceStep — lets user pick a cost tier (local / budget / middle / premium).
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getTierLabel, getTierEmoji, type CostTier } from '../../../core/model-tiers';
import { applyTierFilter } from './model-filters';
import type { OnboardingAction, OnboardingState } from './types';

const ALL_TIERS: CostTier[] = ['local', 'budget', 'middle', 'premium'];

export interface CostPreferenceStepProps {
  state: OnboardingState;
  dispatch: (action: OnboardingAction) => void;
  isActive: boolean;
}

export function CostPreferenceStep({ state, dispatch, isActive }: CostPreferenceStepProps): React.ReactElement {
  const hasLocalModels = state.allModels.some(m => m.tier === 'local');
  const tiers = hasLocalModels ? ALL_TIERS : ALL_TIERS.filter(t => t !== 'local');

  const [focusIndex, setFocusIndex] = useState(0);

  useInput((input, key) => {
    if (!isActive) return;

    if (key.escape) {
      dispatch({ type: 'goBack' });
      return;
    }
    if (key.upArrow) {
      setFocusIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setFocusIndex(prev => Math.min(tiers.length - 1, prev + 1));
    } else if (key.return || input === ' ') {
      const selectedTier = tiers[focusIndex]!;
      dispatch({ type: 'setCostPreference', value: selectedTier });

      const result = applyTierFilter(state.allModels, selectedTier);
      if (result.models.length === 0) {
        dispatch({ type: 'setError', value: 'No models match your preference. Try a different tier.' });
        return;
      }

      dispatch({ type: 'setAvailableModels', value: result.models });
      dispatch({ type: 'setSelectedSpecs', value: new Set(result.defaultSelections) });
      dispatch({ type: 'goToStep', step: 'select-models' });
    }
  }, { isActive });

  const tierItems = tiers.map(tier => ({ tier, label: getTierLabel(tier) }));

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Select Your Cost Preference
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Choose a cost tier to see recommended models</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {tierItems.map((item, index) => {
          const isFocused = index === focusIndex;
          const tierEmoji = getTierEmoji(item.tier);

          return (
            <Box key={item.tier} marginY={0}>
              {isFocused ? <Text color="yellow">{'❯ '}</Text> : <Text>{'  '}</Text>}
              <Text color={isFocused ? 'cyan' : 'white'} bold={isFocused}>
                {tierEmoji}  {item.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Use ↑↓ to navigate, Enter to select, Esc back</Text>
      </Box>

      {state.error && (
        <Box marginTop={1}>
          <Text color="redBright" bold>
            {state.error}
          </Text>
        </Box>
      )}
    </Box>
  );
}
