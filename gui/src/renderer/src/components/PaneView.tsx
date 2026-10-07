import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

// A pane: a program from config.json's `panes` (the main process runs it in a
// pty) in a terminal. Like a session it stays mounted while another view is on
// screen, kept laid out but invisible, so the program always has a real size.

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

export function PaneView({ name, visible, focus }: { name: string; visible: boolean; focus: boolean }) {
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
    const start = () => {
      exited = false;
      window.binder.paneStart(name, t.cols, t.rows).then(
        (out) => out && t.write(out),
        (e: Error) => t.write(`\x1b[31m${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`),
      );
    };
    const off = window.binder.onPane((n, e) => {
      if (n !== name) return;
      if (e.t === 'data') return t.write(e.data);
      exited = true;
      t.write(`\r\n\x1b[2m[${name} exited${e.code ? ` with code ${e.code}` : ''} · Enter starts it again]\x1b[0m\r\n`);
    });
    t.onData((data) => {
      if (!exited) window.binder.paneInput(name, data);
      else if (data === '\r') {
        t.reset();
        start();
      }
    });
    t.onResize(({ cols, rows }) => window.binder.paneResize(name, cols, rows));
    // ⌘ keys are the window's (⌘1-9, ⌘K, ⌘C), never the program's.
    t.attachCustomKeyEventHandler((e) => !e.metaKey);
    const resized = new ResizeObserver(() => fit.fit());
    resized.observe(box.current!);
    const retheme = () => (t.options.theme = theme());
    dark.addEventListener('change', retheme);
    start();
    return () => {
      dark.removeEventListener('change', retheme);
      resized.disconnect();
      off();
      t.dispose();
    };
  }, [name]);

  useEffect(() => {
    if (focus) term.current?.focus();
  }, [focus]);

  return (
    <div className={`pane${visible ? '' : ' off'}`}>
      <div className="titlebar">
        <span className="pane-title">{name}</span>
      </div>
      <div className="pane-term" ref={box} />
    </div>
  );
}
