import { createRequire } from 'node:module';
import { styled, theme, type Style } from './theme.js';

type Painter = (s: string) => string;
type Highlighter = (code: string, opts: { language?: string; ignoreIllegals?: boolean; theme?: Record<string, Painter> }) => string;
type CliHighlight = { highlight: Highlighter; supportsLanguage: (l: string) => boolean };

// Our own token palette, so highlighting does not depend on chalk's TTY
// detection and matches the rest of the renderer.
const paint = (st: Style): Painter => (s) => styled(s, st, theme.codePlain);
const codeTheme: Record<string, Painter> = {
  keyword: paint({ fg: '#C678DD' }),
  built_in: paint({ fg: '#E5C07B' }),
  type: paint({ fg: '#E5C07B' }),
  class: paint({ fg: '#E5C07B' }),
  title: paint({ fg: '#61AFEF' }),
  function: paint({ fg: '#61AFEF' }),
  section: paint({ fg: '#61AFEF', bold: true }),
  literal: paint({ fg: '#D19A66' }),
  number: paint({ fg: '#D19A66' }),
  string: paint({ fg: '#98C379' }),
  regexp: paint({ fg: '#98C379' }),
  symbol: paint({ fg: '#56B6C2' }),
  variable: paint({ fg: '#D7DAE0' }),
  'template-variable': paint({ fg: '#D19A66' }),
  params: paint({ fg: '#D7DAE0' }),
  attr: paint({ fg: '#D19A66' }),
  attribute: paint({ fg: '#D19A66' }),
  meta: paint({ fg: '#56B6C2' }),
  'meta-keyword': paint({ fg: '#C678DD' }),
  'meta-string': paint({ fg: '#98C379' }),
  comment: paint({ fg: '#7F848E', italic: true }),
  doctag: paint({ fg: '#7F848E', italic: true, bold: true }),
  quote: paint({ fg: '#7F848E', italic: true }),
  tag: paint({ fg: '#D7DAE0' }),
  name: paint({ fg: '#E06C75' }),
  'builtin-name': paint({ fg: '#E5C07B' }),
  'selector-tag': paint({ fg: '#C678DD' }),
  'selector-id': paint({ fg: '#61AFEF' }),
  'selector-class': paint({ fg: '#D19A66' }),
  'selector-attr': paint({ fg: '#D19A66' }),
  'selector-pseudo': paint({ fg: '#56B6C2' }),
  bullet: paint({ fg: '#61AFEF' }),
  link: paint({ fg: '#61AFEF', underline: true }),
  emphasis: paint({ italic: true }),
  strong: paint({ bold: true }),
  // Diff colors follow Claude Code's daltonized theme: blue added, orange removed.
  addition: paint({ fg: '#61AFEF' }),
  deletion: paint({ fg: '#D19A66' }),
  default: (s) => s,
};

let lib: CliHighlight | null | undefined;

const ALIASES: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  yml: 'yaml', jsonl: 'json', py: 'python', rb: 'ruby', rs: 'rust', md: 'markdown',
  text: '', txt: '', plaintext: '', '': '',
};

// cli-highlight is CommonJS and takes ~80ms to load, so it is required on
// first use rather than at startup.
function load(): CliHighlight | null {
  if (lib !== undefined) return lib;
  try {
    lib = createRequire(import.meta.url)('cli-highlight') as CliHighlight;
  } catch {
    lib = null;
  }
  return lib;
}

export function preloadHighlighter(): void {
  setTimeout(load, 0);
}

export function highlightCode(code: string, lang: string | undefined): string {
  const name = ALIASES[(lang ?? '').toLowerCase()] ?? (lang ?? '').toLowerCase();
  const h = load();
  if (h && name && h.supportsLanguage(name)) {
    try {
      return styled(h.highlight(code, { language: name, ignoreIllegals: true, theme: codeTheme }), theme.codePlain);
    } catch {
      // fall through to plain
    }
  }
  return styled(code, theme.codePlain);
}
