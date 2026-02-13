import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getAvailableRoleTemplates } from '../../../core/role-templates';
import type { OnboardingAction, OnboardingState, AvailableModel } from './types';

export interface AskRolesStepProps {
  workingDir: string;
  dispatch: (action: OnboardingAction) => void;
  isActive: boolean;
}

export function AskRolesStep({ workingDir, dispatch, isActive }: AskRolesStepProps): React.ReactElement {
  useInput((input, key) => {
    if (!isActive) return;

    if (key.escape) {
      dispatch({ type: 'goBack' });
      return;
    }
    if (input.toLowerCase() === 'y' || key.return) {
      const templates = getAvailableRoleTemplates(workingDir);
      dispatch({ type: 'setRoleTemplates', value: templates });
      dispatch({ type: 'setRoleAssignments', value: new Map() });
      dispatch({ type: 'setChatMode', value: 'role_based' });
      dispatch({ type: 'goToStep', step: 'assign-roles' });
    } else if (input.toLowerCase() === 'n') {
      dispatch({ type: 'setRoleAssignments', value: new Map() });
      dispatch({ type: 'goToStep', step: 'confirm' });
    }
  }, { isActive });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Assign Roles
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>Would you like to assign a specialized role to each model?</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          Roles shape how each model behaves (e.g. Developer, QA, Designer).
        </Text>
      </Box>

      <Box>
        <Text>
          Assign roles? <Text color="green">[Y]es / Enter</Text> / <Text color="yellow">[N]o</Text>
        </Text>
      </Box>
    </Box>
  );
}

export interface AssignRolesStepProps {
  state: OnboardingState;
  dispatch: (action: OnboardingAction) => void;
  isActive: boolean;
}

function getSelectedModelsList(state: OnboardingState): AvailableModel[] {
  return state.availableModels.filter(m => state.selectedSpecs.has(m.spec));
}

export function AssignRolesStep({ state, dispatch, isActive }: AssignRolesStepProps): React.ReactElement {
  const [roleFocusIndex, setRoleFocusIndex] = useState(0);
  const [roleModelIndex, setRoleModelIndex] = useState(0);

  const { roleTemplates, roleAssignments } = state;

  const selectedModels = getSelectedModelsList(state);
  const currentModel = selectedModels[roleModelIndex];

  useInput((input, key) => {
    if (!isActive) return;

    if (key.escape) {
      dispatch({ type: 'goBack' });
      return;
    }
    if (key.upArrow) {
      setRoleFocusIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setRoleFocusIndex(prev => Math.min(roleTemplates.length - 1, prev + 1));
    } else if (key.return || input === ' ') {
      const modelItem = selectedModels[roleModelIndex];
      const selectedRole = roleTemplates[roleFocusIndex];
      if (modelItem && selectedRole) {
        const newAssignments = new Map(roleAssignments);
        newAssignments.set(modelItem.spec, selectedRole.id);
        dispatch({ type: 'setRoleAssignments', value: newAssignments });

        if (roleModelIndex < selectedModels.length - 1) {
          setRoleModelIndex(prev => prev + 1);
          setRoleFocusIndex(0);
        } else {
          dispatch({ type: 'goToStep', step: 'confirm' });
        }
      }
    }
  }, { isActive });

  if (!currentModel) {
    // Safety fallback — should not happen in practice
    dispatch({ type: 'goToStep', step: 'confirm' });
    return <Text>Loading...</Text>;
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Assign Role: {currentModel.displayName}
        </Text>
        <Text dimColor> ({roleModelIndex + 1}/{selectedModels.length})</Text>
      </Box>

      {roleTemplates[0]?.isProjectAgent && (
        <Box marginBottom={1}>
          <Text dimColor>Roles loaded from .cebus/agents/</Text>
        </Box>
      )}

      <Box flexDirection="column" marginBottom={1}>
        {roleTemplates.map((template, index) => {
          const isFocused = index === roleFocusIndex;

          return (
            <Box key={template.id} marginY={0}>
              {isFocused ? <Text color="yellow">{'❯ '}</Text> : <Text>{'  '}</Text>}
              <Text color={isFocused ? 'cyan' : 'white'} bold={isFocused}>
                {template.label}
              </Text>
              <Text dimColor>  {template.description}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate, Enter select</Text>
      </Box>
    </Box>
  );
}
