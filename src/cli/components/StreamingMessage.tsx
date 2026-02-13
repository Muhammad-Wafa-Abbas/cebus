import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Participant } from '../../core/types';
import type { AgentActivityEntry } from '../chat-types';
import { PROVIDER_STYLES, MAX_ICON_WIDTH } from '../ui/constants';

export interface ThinkingIndicatorProps {
  participants: Participant[];
  agentActivity?: Map<string, AgentActivityEntry[]> | undefined;
  waiting?: boolean | undefined;
  expanded?: boolean | undefined;
}

export function ThinkingIndicator({
  participants,
  agentActivity,
  waiting = false,
  expanded = false,
}: ThinkingIndicatorProps): React.ReactElement | null {
  if (participants.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {participants.map(p => {
        const entries = agentActivity?.get(p.id);
        const style = PROVIDER_STYLES[p.providerId?.toLowerCase() ?? ''] ?? PROVIDER_STYLES['default']!;
        const iconPad = ' '.repeat(MAX_ICON_WIDTH - style.iconWidth);

        if (!entries || entries.length === 0) {
          // No activity — show provider icon + status
          return (
            <Box key={p.id}>
              <Text color={style.color}>{style.icon}{iconPad} <Spinner type="dots" /></Text>
              <Text color={style.color} bold> {p.displayName}</Text>
              <Text dimColor> {waiting ? 'waiting...' : 'is thinking...'}</Text>
            </Box>
          );
        }

        const MAX_VISIBLE = 4;
        const lastIndex = entries.length - 1;
        const lastEntry = entries[lastIndex];
        const hasActiveToolCall = lastEntry !== undefined && lastEntry.result === undefined;
        const hiddenCount = expanded ? 0 : Math.max(0, entries.length - MAX_VISIBLE);
        const visibleEntries = hiddenCount > 0 ? entries.slice(-MAX_VISIBLE) : entries;

        const activeEntry = hasActiveToolCall ? lastEntry : undefined;
        const completedEntries = activeEntry
          ? visibleEntries.slice(0, visibleEntries.length - 1)
          : visibleEntries;

        return (
          <Box key={p.id} flexDirection="column">
            {/* Model name with provider icon — always show spinner */}
            <Box>
              <Text color={style.color}>{style.icon}{iconPad} <Spinner type="dots" /></Text>
              <Text bold color={style.color}> {p.displayName}</Text>
            </Box>
            {/* Collapsed older entries — show toggle hint */}
            {hiddenCount > 0 && (
              <Box>
                <Text dimColor>{'   ... '}{hiddenCount} more </Text>
                <Text color="gray">(Tab to expand)</Text>
              </Box>
            )}
            {/* Expanded mode hint */}
            {expanded && entries.length > MAX_VISIBLE && (
              <Box>
                <Text color="gray">{'   (Tab to collapse)'}</Text>
              </Box>
            )}
            {/* Completed activity entries */}
            {completedEntries.map((entry, i) => {
              const hasResult = entry.result !== undefined;
              return (
                <Box key={hiddenCount + i} flexDirection="column">
                  <Box>
                    <Text color="green">{' ✓ '}</Text>
                    <Text>{entry.activity}</Text>
                  </Box>
                  {hasResult && (
                    <Box>
                      <Text dimColor>{'    └ '}{entry.result}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
            {/* Active tool call — show what's happening now */}
            {activeEntry && activeEntry.activity && (
              <Box>
                <Text color="cyan">{' ⠋ '}</Text>
                <Text color="cyan">{activeEntry.activity}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
