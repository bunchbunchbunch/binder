import React from 'react';
import { Box, Text, renderToString } from 'ink';
const cases: Record<string, string> = {
  bold: '\x1b[1mbold\x1b[22m',
  italic: '\x1b[3mital\x1b[23m',
  dim: '\x1b[2mdim\x1b[22m',
  strike: '\x1b[9mstrike\x1b[29m',
  overline: '\x1b[53mover\x1b[55m',
  curly: '\x1b[4:3mcurly\x1b[4:0m',
  curlyColor: '\x1b[4:3m\x1b[58:2::255:80:80mcurlyred\x1b[59m\x1b[4:0m',
  truecolor: '\x1b[38;2;120;200;255mtc\x1b[39m',
  bg: '\x1b[48;2;40;44;52mbg\x1b[49m',
  osc8: '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\',
  osc8bel: '\x1b]8;;https://example.com\x07link\x1b]8;;\x07',
  dech: '\x1b#3DOUBLE',
};
for (const [name, seq] of Object.entries(cases)) {
  const out = renderToString(<Box width={40}><Text>{seq}</Text></Box>);
  console.log(name.padEnd(12), JSON.stringify(out.trimEnd()));
}
// wrapping: does a styled span survive a wrap?
const long = '\x1b[38;2;120;200;255m' + 'word '.repeat(12) + '\x1b[39m';
console.log('wrap', JSON.stringify(renderToString(<Box width={20}><Text>{long}</Text></Box>)));
