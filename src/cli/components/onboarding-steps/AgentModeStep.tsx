/**
 * AgentModeStep — lets users configure Worker vs Advisor mode for Copilot models.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentMode } from '../../../core/types';
import type { OnboardingAction, OnboardingState, AvailableModel } from './types';

export interface AskAgentModeStepProps {
  state: OnboardingState;
  dispatch: (action: OnboardingAction) => void;
  isActive: boolean;
}

function getSelectedModels(state: OnboardingState): AvailableModel[] {
  return state.availableModels.filter(m => state.selectedSpecs.has(m.spec));
}

function buildDefaultAssignments(selectedModels: AvailableModel[]): Map<string, AgentMode> {
  const assignments = new Map<string, AgentMode>();
  for (const model of selectedModels) {
    assignments.set(model.spec, model.workerCapable ? 'worker' : 'advisor');
  }
  return assignments;
}

/**
 * Ask whether the user wants to configure agent modes.
 * Auto-skips to 'confirm' if no Copilot models are selected or folder access is off.
 */
export function AskAgentModeStep({ state, dispatch, isActive }: AskAgentModeStepProps): React.ReactElement {
  const selectedModels = getSelectedModels(state);
  const hasCopilotWithAccess = state.folderAccess && selectedModels.some(m => m.workerCapable);

  useEffect(() => {
    if (!hasCopilotWithAccess) {
      // All models become advisors — skip this step entirely
      const assignments = new Map<string, AgentMode>();
      for (const model of selectedModels) {
        assignments.set(model.spec, 'advisor');
      }
      dispatch({ type: 'setAgentModeAssignments', value: assignments });
      dispatch({ type: 'replaceStep', step: 'confirm' });
    }
  }, [hasCopilotWithAccess]); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input, key) => {
    if (!isActive || !hasCopilotWithAccess) return;

    if (key.escape) {
      dispatch({ type: 'goBack' });
      return;
    }
    if (input.toLowerCase() === 'y' || key.return) {
      dispatch({ type: 'goToStep', step: 'assign-agent-mode' });
    } else if (input.toLowerCase() === 'n') {
      // Use defaults: copilot → worker, others → advisor
      dispatch({ type: 'setAgentModeAssignments', value: buildDefaultAssignments(selectedModels) });
      dispatch({ type: 'goToStep', step: 'confirm' });
    }
  }, { isActive: isActive && hasCopilotWithAccess });

  if (!hasCopilotWithAccess) {
    return <Text>Skipping...</Text>;
  }

  const copilotCount = selectedModels.filter(m => m.workerCapable).length;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Agent Mode
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          You have {copilotCount} Copilot model{copilotCount !== 1 ? 's' : ''} with <Text color="magenta">Worker</Text> capability (file editing, shell commands).
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          Workers can read/edit files and run commands. Advisors are chat-only.
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          Default: Copilot models = Worker, all others = Advisor (chat-only).
        </Text>
      </Box>

      <Box>
        <Text>
          Customize agent modes? <Text color="green">[Y]es</Text> / <Text color="yellow">[N]o (use defaults)</Text>
        </Text>
      </Box>
    </Box>
  );
}

export interface AssignAgentModeStepProps {
  state: OnboardingState;
  dispatch: (action: OnboardingAction) => void;
  isActive: boolean;
}

/**
 * Per-model mode assignment for Copilot models only.
 */
export function AssignAgentModeStep({ state, dispatch, isActive }: AssignAgentModeStepProps): React.ReactElement {
  const selectedModels = getSelectedModels(state);
  const copilotModels = selectedModels.filter(m => m.workerCapable);

  const [modelIndex, setModelIndex] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const [assignments, setAssignments] = useState<Map<string, AgentMode>>(() => buildDefaultAssignments(selectedModels));

  const currentModel = copilotModels[modelIndex];
  const options: { mode: AgentMode; label: string; description: string }[] = [
    { mode: 'worker', label: 'Worker', description: 'Can read/edit files and run shell commands' },
    { mode: 'advisor', label: 'Advisor', description: 'Chat-only, no file or shell access' },
  ];

  useInput((input, key) => {
    if (!isActive) return;

    if (key.escape) {
      dispatch({ type: 'goBack' });
      return;
    }
    if (key.upArrow) {
      setFocusIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setFocusIndex(prev => Math.min(options.length - 1, prev + 1));
    } else if (key.return || input === ' ') {
      if (currentModel) {
        const selected = options[focusIndex];
        if (selected) {
          const next = new Map(assignments);
          next.set(currentModel.spec, selected.mode);
          setAssignments(next);

          if (modelIndex < copilotModels.length - 1) {
            setModelIndex(prev => prev + 1);
            setFocusIndex(0);
          } else {
            dispatch({ type: 'setAgentModeAssignments', value: next });
            dispatch({ type: 'goToStep', step: 'confirm' });
          }
        }
      }
    }
  }, { isActive });

  if (!currentModel) {
    dispatch({ type: 'setAgentModeAssignments', value: assignments });
    dispatch({ type: 'goToStep', step: 'confirm' });
    return <Text>Loading...</Text>;
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Agent Mode: {currentModel.displayName}
        </Text>
        <Text dimColor> ({modelIndex + 1}/{copilotModels.length})</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {options.map((option, index) => {
          const isFocused = index === focusIndex;

          return (
            <Box key={option.mode}>
              {isFocused ? <Text color="yellow">{'> '}</Text> : <Text>{'  '}</Text>}
              <Text color={isFocused ? (option.mode === 'worker' ? 'magenta' : 'cyan') : 'white'} bold={isFocused}>
                {option.label}
              </Text>
              <Text dimColor>  {option.description}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{'↑↓'} navigate, Enter select</Text>
      </Box>
    </Box>
  );
}
