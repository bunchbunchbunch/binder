// Render a markdown file to the terminal with the binder renderer.
//   npx tsx test/manual/renderMd.ts [file] [width] [classic|vivid]
import { readFileSync } from 'node:fs';
import { renderMarkdown } from '../../src/ui/markdown.js';
import { setMarkdownStyle, type MarkdownStyle } from '../../src/ui/md/theme.js';

const file = process.argv[2] ?? 'fixtures/sample.md';
const width = Number(process.argv[3] ?? process.stdout.columns ?? 100);
const text = readFileSync(file, 'utf8');
setMarkdownStyle((process.argv[4] ?? 'classic') as MarkdownStyle);

const t0 = performance.now();
const out = renderMarkdown(text, width);
const t1 = performance.now();
for (let i = 0; i < 20; i++) renderMarkdown(text, width);
const t2 = performance.now();

process.stdout.write(out + '\n');
process.stderr.write(`first render ${(t1 - t0).toFixed(1)}ms (includes highlighter load), warm avg ${((t2 - t1) / 20).toFixed(2)}ms, ${text.length} chars\n`);
