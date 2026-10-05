import React from 'react';
import { readFileSync } from 'node:fs';
import { Box, Text } from 'ink';
import { modelDisplayName } from '../statusline.js';

// From src/ui or dist/ui alike.
const VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// A binder with three index tabs and two ring holes, one letter per pixel.
// Each row of text draws two pixel rows with half blocks.
const LOGO = [
  '.YY.GG.PP',
  'CCCCCCCCC',
  'CCCCCCCCC',
  'C.CCCCC.C',
  'CCCCCCCCC',
  'CCCCCCCCC',
];
const COLORS: Record<string, string> = { C: '#7CC4FF', Y: '#E8C07D', G: '#98C379', P: '#C9A0FF' };

// Its name in the "ANSI Shadow" figlet font: the blocks in the terminal's own
// text color, so it reads on light and dark themes, and the shadow dimmed.
const WORD = [
  '██████╗ ██╗███╗   ██╗██████╗ ███████╗██████╗',
  '██╔══██╗██║████╗  ██║██╔══██╗██╔════╝██╔══██╗',
  '██████╔╝██║██╔██╗ ██║██║  ██║█████╗  ██████╔╝',
  '██╔══██╗██║██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗',
  '██████╔╝██║██║ ╚████║██████╔╝███████╗██║  ██║',
  '╚═════╝ ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝',
];
// The name and version with the logo at double size beside them, and the padding.
const WIDE_COLUMNS = 2 + 2 * LOGO[0].length + 3 + Math.max(...WORD.map((l) => l.length)) + `  v${VERSION}`.length + 1;

type Cell = { ch: string; color?: string; bg?: string };

function halfBlocks(top: string, bottom: string): Cell[] {
  return [...top].map((t, i) => {
    const up = COLORS[t];
    const down = COLORS[bottom[i]];
    if (up && down) return up === down ? { ch: '█', color: up } : { ch: '▀', color: up, bg: down };
    if (up) return { ch: '▀', color: up };
    if (down) return { ch: '▄', color: down };
    return { ch: ' ' };
  });
}

const textRows = (art: string[]) => Array.from({ length: art.length / 2 }, (_, i) => halfBlocks(art[2 * i], art[2 * i + 1]));
const LOGO_ROWS = textRows(LOGO);
// Each pixel twice as wide and twice as tall, as tall as the name.
const BIG_LOGO_ROWS = textRows(LOGO.flatMap((row) => Array(2).fill(row.replace(/./g, '$&$&'))));

function Pixels({ cells }: { cells: Cell[] }) {
  return cells.map((c, j) => (
    <Text key={j} color={c.color} backgroundColor={c.bg}>
      {c.ch}
    </Text>
  ));
}

type Props = { model?: string; effort?: string; plan?: string; cwd: string; width: number };

// Shown before the first prompt, like Claude Code's header: what is running and where.
export function Welcome({ model, effort, plan, cwd, width }: Props) {
  const name = modelDisplayName(model);
  const setup = [name && (effort ? `${name} with ${effort} effort` : name), plan].filter(Boolean).join(' · ');
  const version = <Text dimColor>{` v${VERSION}`}</Text>;
  const wide = width >= WIDE_COLUMNS;
  // A window too short for all of it cuts off the bottom rather than squeezing rows together.
  return (
    <Box flexDirection="column" overflow="hidden">
      <Box paddingX={1} paddingTop={1} flexShrink={0}>
        <Box flexDirection="column" flexShrink={0} width={(wide ? 2 : 1) * LOGO[0].length} marginLeft={1} marginRight={3}>
          {(wide ? BIG_LOGO_ROWS : LOGO_ROWS).map((cells, i) => (
            <Text key={i}>
              <Pixels cells={cells} />
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          {wide ? (
            WORD.map((line, i) => (
              <Text key={i} wrap="truncate-end">
                {line.match(/█+|[^█]+/g)!.map((run, j) => (
                  <Text key={j} dimColor={run[0] !== '█'}>
                    {run}
                  </Text>
                ))}
                {i === WORD.length - 1 && <>{' '}{version}</>}
              </Text>
            ))
          ) : (
            <Text wrap="truncate-end">
              <Text bold>Binder</Text>
              {version}
            </Text>
          )}
          <Text dimColor wrap="truncate-end">{setup || ' '}</Text>
          <Text dimColor wrap="truncate-middle">{cwd}</Text>
        </Box>
      </Box>
    </Box>
  );
}
