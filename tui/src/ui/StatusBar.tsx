import React from 'react';
import { Box, Text } from 'ink';
import { clean } from './md/text.js';

export function StatusBar({ line, notice }: { line: string; notice?: string }) {
  return (
    <Box flexDirection="column">
      {notice ? <Text color="yellow">{clean(notice)}</Text> : null}
      <Text>{line}</Text>
    </Box>
  );
}
