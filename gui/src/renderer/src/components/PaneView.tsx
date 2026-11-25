import { TermView } from './TermView';

// A pane: a program from config.json's `panes` (the main process runs it in a
// pty) in a terminal. Like a session it stays mounted while another view is on
// screen, kept laid out but invisible, so the program always has a real size.

export function PaneView({ name, visible, focus }: { name: string; visible: boolean; focus: boolean }) {
  return (
    <div className={`pane${visible ? '' : ' off'}`}>
      <div className="titlebar">
        <span className="pane-title">{name}</span>
      </div>
      <TermView name={name} label={name} start={(cols, rows) => window.binder.paneStart(name, cols, rows)} focus={focus} />
    </div>
  );
}
