import React from 'react';
import { Box, Text } from 'ink';
import { MarkdownText } from '../MarkdownText';
import { getRoleTemplate } from '../../../core/role-templates';
import {
  MAX_ICON_WIDTH,
  PROVIDER_STYLES,
  USER_COLOR,
  USER_ICON,
  USER_ICON_WIDTH,
  CONTENT_PADDING,
  ORCHESTRATOR_STYLE,
} from '../../ui/constants';
import type { Participant } from '../../../core/types';
import type { StaticEntry } from '../../chat-types';

type ParticipantStyle = { color: string; icon: string; iconWidth: number };

/** Resolve the display style for a participant (icon, color, width). */
export function getParticipantStyle(
  participantId: string,
  isUser: boolean,
  participantMap: Map<string, Participant>,
  orchestratorParticipantId: string | undefined,
): ParticipantStyle {
  if (isUser) {
    return { color: USER_COLOR, icon: USER_ICON, iconWidth: USER_ICON_WIDTH };
  }
  if (participantId === orchestratorParticipantId) {
    return ORCHESTRATOR_STYLE;
  }
  const participant = participantMap.get(participantId);
  const providerId = participant?.providerId?.toLowerCase() ?? 'default';
  return PROVIDER_STYLES[providerId] ?? PROVIDER_STYLES['default']!;
}

interface StaticEntryRendererProps {
  entry: StaticEntry;
  participantMap: Map<string, Participant>;
  orchestratorParticipantId: string | undefined;
  showTimestamps: boolean;
}

export function StaticEntryRenderer({
  entry,
  participantMap,
  orchestratorParticipantId,
  showTimestamps,
}: StaticEntryRendererProps): React.ReactElement {
  if (entry.kind === 'message') {
    const message = entry.message;
    const sender = participantMap.get(message.senderId);
    const isUser = message.type === 'user';
    const { color: senderColor, icon: senderIcon, iconWidth } = getParticipantStyle(
      message.senderId, isUser, participantMap, orchestratorParticipantId
    );
    const iconPad = ' '.repeat(MAX_ICON_WIDTH - iconWidth);
    const timeStr = new Date(message.timestamp).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });

    return (
      <Box key={entry.id} flexDirection="column" marginTop={1}>
        <Box>
          <Text color={senderColor}>
            {senderIcon}{iconPad} <Text bold>{sender?.displayName ?? 'Unknown'}</Text>
          </Text>
          {sender?.role && (
            <Text color="#b0b0b0"> [{getRoleTemplate(sender.role)?.label ?? sender.role}]</Text>
          )}
          {isUser && message.directedTo && message.directedTo.length > 0 && (
            <Text dimColor> {'\u2192'} {message.directedTo.map(id => participantMap.get(id)?.displayName ?? id).join(', ')}</Text>
          )}
          {showTimestamps && <Text dimColor> {timeStr}</Text>}
          {message.status === 'error' && <Text color="redBright" bold> ✗</Text>}
        </Box>
        <Box paddingLeft={CONTENT_PADDING}>
          <MarkdownText content={message.content} />
        </Box>
        {message.status === 'error' && message.completionMeta?.error && (
          <Box paddingLeft={CONTENT_PADDING}>
            <Text color="redBright" bold>
              Error: {message.completionMeta.error.message}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (entry.kind === 'stream-header') {
    const sender = participantMap.get(entry.senderId);
    const { color: senderColor, icon: senderIcon, iconWidth } = getParticipantStyle(
      entry.senderId, false, participantMap, orchestratorParticipantId
    );
    const iconPad = ' '.repeat(MAX_ICON_WIDTH - iconWidth);
    return (
      <Box key={entry.id} flexDirection="column" marginTop={1}>
        <Box>
          <Text color={senderColor}>
            {senderIcon}{iconPad} <Text bold>{sender?.displayName ?? 'Unknown'}</Text>
          </Text>
          {sender?.role && (
            <Text color="#b0b0b0"> [{getRoleTemplate(sender.role)?.label ?? sender.role}]</Text>
          )}
        </Box>
        {entry.guidance && (
          <Box paddingLeft={CONTENT_PADDING}>
            <Text dimColor italic>Orchestrator: {entry.guidance.length > 120 ? entry.guidance.slice(0, 117) + '...' : entry.guidance}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (entry.kind === 'plan') {
    return (
      <Box
        key={entry.id}
        flexDirection="column"
        marginY={1}
        borderStyle="round"
        borderColor={entry.approved ? 'green' : 'red'}
        paddingX={2}
        paddingY={1}
      >
        <Text color="magenta" bold>
          Orchestrator plan {entry.approved ? '(approved)' : '(rejected)'}:
        </Text>
        <Text dimColor>{entry.plan.description}</Text>
        <Box flexDirection="column" marginTop={1}>
          {entry.plan.steps.map((step, i) => (
            <Text key={i}>
              {' '}{i + 1}. <Text bold>{step.agentId}</Text>: {step.action}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Estimated rounds: {entry.plan.estimatedRounds} | Cost: {entry.plan.estimatedCost}
          </Text>
        </Box>
      </Box>
    );
  }

  // stream-text — flushed streaming line (spacer entries have whitespace-only content)
  if (entry.content.trim() === '') {
    return <Text key={entry.id}>{' '}</Text>;
  }
  return (
    <Box key={entry.id} paddingLeft={CONTENT_PADDING}>
      <MarkdownText content={entry.content} />
    </Box>
  );
}
