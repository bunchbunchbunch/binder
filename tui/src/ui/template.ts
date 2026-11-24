// Text templates as the Mac app's sidebar and status bar read them
// (bindergui src/renderer/src/lib/sidebarText.ts): `{field}` puts in a field,
// `{a|b}` the first of them with a value, and text in `( )` shows only when a
// field inside it has one. A backslash makes the next character plain text.
// Spaces left by empty fields collapse; a placeholder naming no known field
// stays as written, so a typo shows.

type Node = string | { names: string[]; raw: string } | { group: Node[] };

function parse(src: string): Node[] {
  let i = 0;
  const seq = (inGroup: boolean): Node[] => {
    const out: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push(text);
      text = '';
    };
    while (i < src.length) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length) {
        text += src[i + 1];
        i += 2;
      } else if (c === '{' && src.indexOf('}', i) > i) {
        flush();
        const raw = src.slice(i, src.indexOf('}', i) + 1);
        out.push({ names: raw.slice(1, -1).split('|').map((n) => n.trim()), raw });
        i += raw.length;
      } else if (c === '(') {
        flush();
        i++;
        out.push({ group: seq(true) });
      } else if (c === ')' && inGroup) {
        i++;
        break;
      } else {
        text += c;
        i++;
      }
    }
    flush();
    return out;
  };
  return seq(false);
}

function render(nodes: Node[], values: Record<string, string>): { text: string; fields: number; filled: number } {
  let text = '';
  let fields = 0;
  let filled = 0;
  for (const n of nodes) {
    if (typeof n === 'string') text += n;
    else if ('names' in n) {
      if (!n.names.every((name) => name in values)) {
        text += n.raw;
        continue;
      }
      const v = n.names.map((name) => values[name]).find(Boolean) ?? '';
      fields++;
      if (v) filled++;
      text += v;
    } else {
      const g = render(n.group, values);
      fields += g.fields;
      filled += g.filled;
      if (g.fields === 0 || g.filled > 0) text += g.text;
    }
  }
  return { text, fields, filled };
}

/** `template` filled from `values`, whose keys are the fields it knows (empty string: no value). */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return render(parse(template), values).text.replace(/\s+/g, ' ').trim();
}
