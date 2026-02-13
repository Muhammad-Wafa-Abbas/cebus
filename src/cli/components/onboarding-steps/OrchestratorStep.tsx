import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { discoverOrchestratorLLMOptions } from '../../../core/orchestrator-llm-options';
import {
  rebuildOrchestratorOptions as rebuildOptions,
  hasMoreOrchestratorModels,
} from './model-filters';
import type { OnboardingAction, OnboardingState, OnboardingStep } from './types';

export interface AskOrchestratorStepProps {
  dispatch: (action: OnboardingAction) => void;
  isActive: boolean;
}

export function AskOrchestratorStep({ dispatch, isActive }: AskOrchestratorStepProps): React.ReactElement {
  useInput((input, key) => {
    if (!isActive) return;

    if (key.escape) {
      dispatch({ type: 'goBack' });
      return;
    }
    if (input.toLowerCase() === 'y' || key.return) {
      dispatch({ type: 'setOrchestratorEnabled', value: true });
      // Load orchestrator LLM options
      void (async () => {
        try {
          const options = await discoverOrchestratorLLMOptions();
          if (options.length === 0) {
            dispatch({ type: 'setError', value: 'No orchestrator models available. Skipping orchestrator.' });
            dispatch({ type: 'setOrchestratorEnabled', value: false });
            dispatch({ type: 'goToStep', step: 'ask-roles' as OnboardingStep });
            return;
          }
          dispatch({ type: 'setAllOrchestratorOptions', value: options });
          dispatch({ type: 'setExpandedOrchestratorProviders', value: new Set() });
          const visible = rebuildOptions(options, new Set());
          dispatch({ type: 'setOrchestratorOptions', value: visible });
          dispatch({ type: 'goToStep', step: 'select-orchestrator' as OnboardingStep });
        } catch {
          dispatch({ type: 'setError', value: 'Failed to load orchestrator models. Skipping.' });
          dispatch({ type: 'setOrchestratorEnabled', value: false });
          dispatch({ type: 'goToStep', step: 'ask-roles' as OnboardingStep });
        }
      })();
    } else if (input.toLowerCase() === 'n') {
      dispatch({ type: 'setOrchestratorEnabled', value: false });
      dispatch({ type: 'goToStep', step: 'ask-roles' });
    }
  }, { isActive });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          AI Orchestrator
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>Would you like to enable an AI Orchestrator?</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          The orchestrator analyzes each message, manages agent discussions,
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>
          and can orchestrate multi-round tasks. Pick any available model (free with Ollama/Copilot).
        </Text>
      </Box>

      <Box>
        <Text>
          Enable orchestrator? <Text color="green">[Y]es / Enter</Text> / <Text color="yellow">[N]o</Text>
        </Text>
      </Box>
    </Box>
  );
}

export interface SelectOrchestratorStepProps {
  state: OnboardingState;
  dispatch: (action: OnboardingAction) => void;
  isActive: boolean;
}

export function SelectOrchestratorStep({ state, dispatch, isActive }: SelectOrchestratorStepProps): React.ReactElement {
  const [focusIndex, setFocusIndex] = useState(0);

  const { allOrchestratorOptions, orchestratorOptions, expandedOrchestratorProviders, error } = state;

  function toggleShowMore(providerId: string): void {
    const isExpanded = expandedOrchestratorProviders.has(providerId);
    let newExpanded: Set<string>;
    if (isExpanded) {
      newExpanded = new Set(expandedOrchestratorProviders);
      newExpanded.delete(providerId);
    } else {
      newExpanded = new Set(expandedOrchestratorProviders);
      newExpanded.add(providerId);
    }

    dispatch({ type: 'setExpandedOrchestratorProviders', value: newExpanded });

    const focusedSpec = orchestratorOptions[focusIndex]?.spec;
    const rebuilt = rebuildOptions(allOrchestratorOptions, newExpanded);
    dispatch({ type: 'setOrchestratorOptions', value: rebuilt });

    if (focusedSpec) {
      const newIndex = rebuilt.findIndex(o => o.spec === focusedSpec);
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
      setFocusIndex(prev => Math.min(orchestratorOptions.length - 1, prev + 1));
    } else if (input === 'm') {
      const currentOption = orchestratorOptions[focusIndex];
      if (currentOption) {
        toggleShowMore(currentOption.provider);
      }
    } else if (key.return || input === ' ') {
      const selected = orchestratorOptions[focusIndex];
      if (selected) {
        dispatch({ type: 'setOrchestratorSpec', value: selected.spec });
        dispatch({ type: 'goToStep', step: 'ask-roles' });
      }
    }
  }, { isActive });

  // Group visible orchestrator options by provider
  const svByProvider = new Map<string, typeof orchestratorOptions>();
  for (const option of orchestratorOptions) {
    if (!svByProvider.has(option.provider)) {
      svByProvider.set(option.provider, []);
    }
    svByProvider.get(option.provider)!.push(option);
  }

  let svGlobalIndex = 0;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Select Orchestrator Model
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          Choose a model with a large context window for best orchestration results
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          ↑↓ navigate • M show more • Enter select • Esc back
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {Array.from(svByProvider.entries()).map(([provider, options]) => (
          <Box key={provider} flexDirection="column" marginBottom={1}>
            <Text bold color="cyan">
              {provider.toUpperCase()}
            </Text>

            {options.map(option => {
              const index = svGlobalIndex++;
              const isFocused = index === focusIndex;

              return (
                <Box key={option.spec}>
                  {isFocused ? <Text color="yellow">{'❯ '}</Text> : <Text>{'  '}</Text>}
                  <Text color={isFocused ? 'cyan' : 'white'} bold={isFocused}>
                    {option.displayName}
                  </Text>
                  {option.isDefault && <Text color="green"> (recommended)</Text>}
                </Box>
              );
            })}

            {hasMoreOrchestratorModels(allOrchestratorOptions, orchestratorOptions, provider) && (
              <Box paddingLeft={2}>
                <Text dimColor italic>
                  ... press M to show more
                </Text>
              </Box>
            )}
          </Box>
        ))}
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
