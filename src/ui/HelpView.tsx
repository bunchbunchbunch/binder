import React from 'react';
import { Box, Text } from 'ink';

const KEYS: Array<[string, string]> = [
  ['Enter', 'send the prompt in a new tab'],
  ['Ctrl+Enter', 'send into the current tab (on a running turn: send now)'],
  ['Shift+Enter, Alt+Enter, \\ Enter', 'newline'],
  ['Up / Down', 'earlier / later prompts'],
  ['Tab, @', 'complete a path (after !, a command)'],
  ['Tab, Right (empty prompt)', 'take the suggested next prompt'],
  ['!command', 'bash mode: run it here, the model sees the output next prompt'],
  ['Ctrl+N / Ctrl+P', 'next / previous tab (also Ctrl+Right / Left, Alt+1-9)'],
  ['Wheel, PgUp / PgDn, Home / End', 'scroll the tab (Option+drag selects text)'],
  ['Esc', 'interrupt the running turn (twice when idle: rewind)'],
  ['Ctrl+]', 'open the latest artifact'],
  ['Ctrl+E', 'expand / collapse the work behind a response'],
  ['Ctrl+O', 'full tool output, thinking, and subagent detail'],
  ['Ctrl+V', 'paste the clipboard: an image, or its text'],
  ['Ctrl+C (text selected)', 'copy the selection'],
  ['Ctrl+C twice', 'quit'],
];

// /help: keys and where the commands are, in place of the transcript until Esc.
export function HelpView({ commandCount }: { commandCount: number }) {
  const w = Math.max(...KEYS.map(([k]) => k.length)) + 2;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="#7CC4FF">Keys</Text>
      {KEYS.map(([k, d]) => (
        <Text key={k}>
          <Text>{'  ' + k.padEnd(w)}</Text>
          <Text dimColor>{d}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text bold color="#7CC4FF">Commands</Text>
      <Text>{`  Type / to browse all ${commandCount}. Binder runs /help, /resume, /clear, /fork, /rewind, /cd, /model, /effort, /mcp, /chrome, /artifacts and /exit itself; the rest go to Claude Code.`}</Text>
      <Text> </Text>
      <Text dimColor>  Esc closes this.</Text>
    </Box>
  );
}
