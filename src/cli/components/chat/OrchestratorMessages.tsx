import React from 'react';
import { Box, Text } from 'ink';
import { MarkdownText } from '../MarkdownText';
import { TaskCompletionCard } from '../TaskCompletionCard';
import { CONTENT_PADDING } from '../../ui/constants';
import type { OrchestratorMessage, PlanProgress, PendingPlanApproval } from '../../chat-types';

interface OrchestratorMessagesProps {
  messages: OrchestratorMessage[];
  orchestratorModelId: string | undefined;
  showTimestamps: boolean;
}

export function OrchestratorMessagesView({
  messages,
  orchestratorModelId,
  showTimestamps,
}: OrchestratorMessagesProps): React.ReactElement | null {
  if (messages.length === 0) return null;

  return (
    <Box flexDirection="column" marginY={1}>
      {messages.map((msg, i) => {
        if (msg.kind === 'direct') {
          const timeStr = msg.timestamp.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });
          return (
            <Box key={i} flexDirection="column">
              <Box>
                <Text color="magenta">
                  {'\u25C6'}{' '}<Text bold>Orchestrator</Text>
                </Text>
                {orchestratorModelId && (
                  <Text color="#b0b0b0"> [{orchestratorModelId}]</Text>
                )}
                {showTimestamps && <Text dimColor> {timeStr}</Text>}
              </Box>
              <Box paddingLeft={CONTENT_PADDING}>
                <MarkdownText content={msg.content} />
              </Box>
              <Text>{' '}</Text>
            </Box>
          );
        }
        if (msg.kind === 'complete' && msg.taskSummary) {
          return (
            <Box key={i} marginY={1}>
              <TaskCompletionCard summary={msg.taskSummary} />
            </Box>
          );
        }
        return (
          <Box key={i} paddingLeft={1}>
            <Text dimColor>Orchestrator: {msg.content}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

interface PlanProgressViewProps {
  planProgress: PlanProgress;
}

export function PlanProgressView({ planProgress }: PlanProgressViewProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      {planProgress.plan.steps.map((step, i) => {
        const isDone = i < planProgress.completed;
        const isActive = i === planProgress.completed && planProgress.activeAgent !== null;
        const icon = isDone ? '\u2713' : isActive ? '\u2192' : '\u00B7';
        const actionText = step.action.length > 70 ? step.action.slice(0, 67) + '...' : step.action;
        return (
          <Box key={i}>
            <Text {...(isDone ? { color: 'green' } : isActive ? { color: 'yellow' } : {})} dimColor={!isDone && !isActive}>
              {icon} {i + 1}. {step.agentId}: {actionText}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

interface PlanApprovalViewProps {
  pendingPlanApproval: PendingPlanApproval;
}

export function PlanApprovalView({ pendingPlanApproval }: PlanApprovalViewProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      marginY={1}
      borderStyle="round"
      borderColor="magenta"
      paddingX={2}
      paddingY={1}
    >
      <Text color="magenta" bold>
        Orchestrator proposes a plan:
      </Text>
      <Text dimColor>{pendingPlanApproval.plan.description}</Text>
      <Box flexDirection="column" marginTop={1}>
        {pendingPlanApproval.plan.steps.map((step, i) => (
          <Text key={i}>
            {' '}{i + 1}. <Text bold>{step.agentId}</Text>: {step.action}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Estimated rounds: {pendingPlanApproval.plan.estimatedRounds} | Cost: {pendingPlanApproval.plan.estimatedCost}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          Approve plan?{' '}
          <Text color="green" bold>[Y]</Text>es /{' '}
          <Text color="red" bold>[N]</Text>o
        </Text>
      </Box>
    </Box>
  );
}
