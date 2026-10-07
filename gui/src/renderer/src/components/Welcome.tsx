import { modelDisplayName, shortPath } from '../lib/format';

// A binder with three index tabs and two ring holes, one letter per pixel (the TUI's logo).
const LOGO = ['.YY.GG.PP', 'CCCCCCCCC', 'CCCCCCCCC', 'C.CCCCC.C', 'CCCCCCCCC', 'CCCCCCCCC'];
const COLORS: Record<string, string> = { C: '#7CC4FF', Y: '#E8C07D', G: '#98C379', P: '#C9A0FF' };

export function Logo({ size = 9 }: { size?: number }) {
  return (
    <div className="logo" style={{ gridTemplateColumns: `repeat(9, ${size}px)`, gridAutoRows: `${size}px` }}>
      {LOGO.flatMap((row, r) => [...row].map((ch, c) => <span key={`${r}-${c}`} style={{ background: COLORS[ch] ?? 'transparent', borderRadius: 1 }} />))}
    </div>
  );
}

// Before the first prompt: what is running and where, like Claude Code's header.
export function Welcome({ model, effort, cwd }: { model?: string | null; effort?: string | null; cwd: string }) {
  const name = modelDisplayName(model);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <Logo size={11} />
        <div>
          <h1>Binder</h1>
          {name && <div className="muted">{effort ? `${name} with ${effort} effort` : name}</div>}
          <div className="muted">{shortPath(cwd)}</div>
          <div className="hint">
            Type a prompt below. Each prompt opens a tab. <kbd>?</kbd> shows the shortcuts.
          </div>
        </div>
      </div>
    </div>
  );
}
