import React from 'react';
import { Box, Text, Newline } from 'ink';

export function ChatEmptyState(): React.ReactElement {
  return (
    <Box flexDirection="column" padding={2}>
      <Text bold>Welcome to Cebus!</Text>
      <Newline />
      <Text dimColor>Start the conversation by typing a message below.</Text>
      <Text dimColor>Use @nickname to direct a message to a specific model.</Text>
      <Text dimColor>Type /help for available commands.</Text>
    </Box>
  );
}
