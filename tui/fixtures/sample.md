# Release notes for binder 0.2

The renderer now handles **bold**, *italic*, ~~struck~~ text, `inline code`, and [links](https://github.com/bunchbunchbunch/bindertui). Long paragraphs wrap to the terminal width without breaking words apart, and entities like &amp; and &lt;tag&gt; come through unescaped.

## What changed

1. Headings are visually distinct at three levels
2. Tables use box-drawing borders and wrap long cells
3. Code blocks sit on a shaded band with the language label
   - Nested bullets indent under their parent
   - And keep wrapping inside the indent when the line gets long enough to need it

### Checklist

- [x] Lexer-based renderer
- [x] Table layout
- [ ] Streaming render

## Comparison

| Feature | marked-terminal | binder renderer | Notes |
|---|:---:|---:|---|
| Headings | bold only | 3 levels | H1 rule, H2 underline, H3 bar |
| Tables | cli-table3 | custom | wraps cells to fit |
| Code | cardinal (JS only) | cli-highlight | 180 languages, lazy loaded |
| Links | plain | OSC 8 | Cmd-click in iTerm2 |

```typescript
export function buildArgs({ sessionId, resume, passthrough }: BuildArgsOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', resume ? '--resume' : '--session-id', sessionId];
  if (!passthrough.includes('--permission-mode')) args.push('--permission-mode', 'bypassPermissions');
  return args.concat(passthrough); // user flags win
}
```

```bash
npm test && npm run build
binder -- --model opus
```

> **Note:** quoted text gets a colored bar and italic body.
> It can span several lines and include `code`.

---

#### Smaller heading

Plain text after a rule. Done.
