import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { ROLE_TEMPLATES } from '../../core/role-templates';
import { getProviderRegistry, initializeProviders } from '../../providers';
import { categorizeModels } from '../../core/model-tiers';
import type { ChatMode, OrchestratorConfig } from '../../core/types';

import {
  PermissionStep,
  CostPreferenceStep,
  ModelSelectionStep,
  ChatModeStep,
  AskOrchestratorStep,
  SelectOrchestratorStep,
  AskRolesStep,
  AssignRolesStep,
  ConfirmStep,
  type OnboardingStep,
  type OnboardingState,
  type OnboardingAction,
} from './onboarding-steps';

export interface OnboardingProps {
  workingDir: string;
  onComplete: (
    selectedModels: string[],
    folderAccess: boolean,
    chatMode: ChatMode,
    roleAssignments: Map<string, string>,
    orchestratorConfig?: OrchestratorConfig | undefined,
  ) => void;
  onCancel: () => void;
}

const INITIAL_STATE: OnboardingState = {
  folderAccess: true,
  costPreference: 'local',
  allModels: [],
  availableModels: [],
  selectedSpecs: new Set(),
  expandedProviders: new Map(),
  chatMode: 'sequential',
  roleAssignments: new Map(),
  roleTemplates: ROLE_TEMPLATES,
  orchestratorEnabled: false,
  allOrchestratorOptions: [],
  orchestratorOptions: [],
  expandedOrchestratorProviders: new Set(),
  orchestratorSpec: null,
  error: null,
};

export function Onboarding({
  workingDir,
  onComplete,
  onCancel,
}: OnboardingProps): React.ReactElement {
  const { exit } = useApp();
  const [step, setStep] = useState<OnboardingStep>('permission');
  const [, setStepHistory] = useState<OnboardingStep[]>([]);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [state, setState] = useState<OnboardingState>(INITIAL_STATE);

  useEffect(() => {
    if (step !== 'loading') return;

    void (async () => {
      try {
        await initializeProviders();
        const registry = getProviderRegistry();
        // Only show providers that are actually available (e.g., Copilot won't show if gh CLI not installed)
        const providers = await registry.getAvailable();

        const providerModels = [];
        for (const provider of providers) {
          if (!registry.isInitialized(provider.id)) {
            continue; // Skip providers that failed to initialize
          }
          const models = await provider.listModels();
          providerModels.push({
            providerId: provider.id,
            providerName: provider.displayName,
            models,
          });
        }

        if (providerModels.length === 0) {
          setState((prev: OnboardingState) => ({
            ...prev,
            error: 'No providers available. Run "cebus config" to see what needs to be configured.'
          }));
          return;
        }

        const tiered = categorizeModels(providerModels);
        setState((prev: OnboardingState) => ({ ...prev, allModels: tiered }));
        setStep('cost-preference');
      } catch (err) {
        setState((prev: OnboardingState) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Failed to load models',
        }));
      }
    })();
  }, [step]);

  useEffect(() => {
    if (state.error) {
      const timeout = setTimeout(
        () => setState((prev: OnboardingState) => ({ ...prev, error: null })),
        3000,
      );
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [state.error]);

  const dispatch = useCallback(
    (action: OnboardingAction) => {
      switch (action.type) {
        case 'goToStep':
          setStepHistory(prev => [...prev, step]);
          setStep(action.step);
          break;
        case 'replaceStep':
          setStep(action.step);
          break;
        case 'goBack': {
          setStepHistory(prev => {
            if (prev.length === 0) {
              setShowExitConfirm(true);
              return prev;
            }
            const history = [...prev];
            const previousStep = history.pop()!;
            setStep(previousStep);
            return history;
          });
          break;
        }
        case 'setFolderAccess':
          setState((prev: OnboardingState) => ({ ...prev, folderAccess: action.value }));
          break;
        case 'setCostPreference':
          setState((prev: OnboardingState) => ({ ...prev, costPreference: action.value }));
          break;
        case 'setAllModels':
          setState((prev: OnboardingState) => ({ ...prev, allModels: action.value }));
          break;
        case 'setAvailableModels':
          setState((prev: OnboardingState) => ({ ...prev, availableModels: action.value }));
          break;
        case 'setSelectedSpecs':
          setState((prev: OnboardingState) => ({ ...prev, selectedSpecs: action.value }));
          break;
        case 'setExpandedProviders':
          setState((prev: OnboardingState) => ({ ...prev, expandedProviders: action.value }));
          break;
        case 'setChatMode':
          setState((prev: OnboardingState) => ({ ...prev, chatMode: action.value }));
          break;
        case 'setRoleAssignments':
          setState((prev: OnboardingState) => ({ ...prev, roleAssignments: action.value }));
          break;
        case 'setRoleTemplates':
          setState((prev: OnboardingState) => ({ ...prev, roleTemplates: action.value }));
          break;
        case 'setOrchestratorEnabled':
          setState((prev: OnboardingState) => ({ ...prev, orchestratorEnabled: action.value }));
          break;
        case 'setAllOrchestratorOptions':
          setState((prev: OnboardingState) => ({ ...prev, allOrchestratorOptions: action.value }));
          break;
        case 'setOrchestratorOptions':
          setState((prev: OnboardingState) => ({ ...prev, orchestratorOptions: action.value }));
          break;
        case 'setExpandedOrchestratorProviders':
          setState((prev: OnboardingState) => ({ ...prev, expandedOrchestratorProviders: action.value }));
          break;
        case 'setOrchestratorSpec':
          setState((prev: OnboardingState) => ({ ...prev, orchestratorSpec: action.value }));
          break;
        case 'setError':
          setState((prev: OnboardingState) => ({ ...prev, error: action.value }));
          break;
        case 'requestExit':
          setShowExitConfirm(true);
          break;
        case 'complete':
          onComplete(
            Array.from(state.selectedSpecs),
            state.folderAccess,
            state.chatMode,
            state.roleAssignments,
            action.orchestratorConfig,
          );
          break;
      }
    },
    [onComplete, step, state.selectedSpecs, state.folderAccess, state.chatMode, state.roleAssignments],
  );

  useInput(() => {}, { isActive: !showExitConfirm });

  useInput(
    (input, key) => {
      if (key.escape || input.toLowerCase() === 'y') {
        onCancel();
        exit();
        setTimeout(() => {
          console.log('');
          console.log('  \x1b[36m\uD83D\uDC4B See you soon! May your code compile on the first try.\x1b[0m');
          console.log('');
          process.exit(0);
        }, 100);
      } else if (input.toLowerCase() === 'n') {
        setShowExitConfirm(false);
      }
    },
    { isActive: showExitConfirm },
  );

  if (showExitConfirm) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="magenta">
            Exit Cebus?
          </Text>
        </Box>
        <Box>
          <Text>
            Are you sure you want to quit? <Text color="green">[Y]es</Text> /{' '}
            <Text color="yellow">[N]o</Text> / <Text dimColor>Esc</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  if (step === 'loading') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>
          <Text color="cyan">{'\u280B'}</Text> Loading available models...
        </Text>
        {state.error && (
          <Box marginTop={1}>
            <Text color="redBright" bold>
              Error: {state.error}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  const isActive = !showExitConfirm;

  switch (step) {
    case 'permission':
      return <PermissionStep workingDir={workingDir} dispatch={dispatch} isActive={isActive} />;
    case 'cost-preference':
      return <CostPreferenceStep state={state} dispatch={dispatch} isActive={isActive} />;
    case 'select-models':
      return <ModelSelectionStep state={state} dispatch={dispatch} isActive={isActive} />;
    case 'select-mode':
      return <ChatModeStep dispatch={dispatch} isActive={isActive} />;
    case 'ask-orchestrator':
      return <AskOrchestratorStep dispatch={dispatch} isActive={isActive} />;
    case 'select-orchestrator':
      return <SelectOrchestratorStep state={state} dispatch={dispatch} isActive={isActive} />;
    case 'ask-roles':
      return <AskRolesStep workingDir={workingDir} dispatch={dispatch} isActive={isActive} />;
    case 'assign-roles':
      return <AssignRolesStep state={state} dispatch={dispatch} isActive={isActive} />;
    case 'confirm':
      return <ConfirmStep state={state} dispatch={dispatch} isActive={isActive} />;
    default:
      return <Text>Unknown step</Text>;
  }
}

export default Onboarding;
