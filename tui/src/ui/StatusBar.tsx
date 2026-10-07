import React from 'react';
import { Box, Text } from 'ink';

export function StatusBar({ line, notice }: { line: string; notice?: string }) {
  return (
    <Box flexDirection="column">
      {notice ? <Text color="yellow">{notice}</Text> : null}
      <Text>{line}</Text>
    </Box>
  );
}
