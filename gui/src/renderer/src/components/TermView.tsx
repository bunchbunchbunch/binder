import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

// A program in a pty, shown in a terminal: a config.json pane (PaneView) or a
// session's own shell (SessionView's ⌃`). `start` asks the main process to run
// it at the terminal's size and resolves with what it printed before.

const dark = matchMedia('(prefers-color-scheme: dark)');

// The app's colors; its gold and green also stand in for ANSI yellow and
// green, which are too pale to read on the light background.
function theme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const [gold, green] = [v('--gold'), v('--green')];
  return {
    background: v('--bg'),
    foreground: v('--text'),
    cursor: v('--text'),
    cursorAccent: v('--bg'),
    selectionBackground: v('--accent-soft'),
    yellow: gold,
    brightYellow: gold,
    green,
    brightGreen: green,
  };
}

export function TermView({ name, label, start, focus, className, onKey }: { name: string; label: string; start: (cols: number, rows: number) => Promise<string>; focus: boolean; className?: string; onKey?: (e: KeyboardEvent) => boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const t = new Terminal({ fontFamily: css.getPropertyValue('--mono'), fontSize: 13, theme: theme() });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(box.current!);
    fit.fit();
    term.current = t;
    let exited = false;
    const run = () => {
      exited = false;
      start(t.cols, t.rows).then(
        (out) => out && t.write(out),
        (e: Error) => t.write(`\x1b[31m${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`),
      );
    };
    const off = window.binder.onPane((n, e) => {
      if (n !== name) return;
      if (e.t === 'data') return t.write(e.data);
      exited = true;
      t.write(`\r\n\x1b[2m[${label} exited${e.code ? ` with code ${e.code}` : ''} · Enter starts it again]\x1b[0m\r\n`);
    });
    t.onData((data) => {
      if (!exited) window.binder.paneInput(name, data);
      else if (data === '\r') {
        t.reset();
        run();
      }
    });
    t.onResize(({ cols, rows }) => window.binder.paneResize(name, cols, rows));
    // ⌘ keys are the window's (⌘1-9, ⌘K, ⌘C), never the program's; so are any the owner takes.
    t.attachCustomKeyEventHandler((e) => !e.metaKey && !(e.type === 'keydown' && onKey?.(e)));
    // Keys typed into the terminal are the program's: they stop here, so the
    // window's own handlers (Esc interrupts a turn, Ctrl+C twice quits) never
    // see them. ⌘ keys go on to the window.
    const own = (e: KeyboardEvent) => {
      if (!e.metaKey) e.stopPropagation();
    };
    const el = box.current!;
    el.addEventListener('keydown', own);
    const resized = new ResizeObserver(() => fit.fit());
    resized.observe(el);
    const retheme = () => (t.options.theme = theme());
    dark.addEventListener('change', retheme);
    run();
    return () => {
      el.removeEventListener('keydown', own);
      dark.removeEventListener('change', retheme);
      resized.disconnect();
      off();
      t.dispose();
    };
  }, [name]);

  useEffect(() => {
    if (focus) term.current?.focus();
  }, [focus]);

  return <div className={className ?? 'pane-term'} ref={box} />;
}
