import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { errText, request, toast } from '../store';
import { samePath, severityName, type Finding } from '../lib/findings';
import { askToFix, wasAsked } from '../components/FindingsCard';
import { Markdown } from '../components/Markdown';

// The diff pane (/diff): every change in the session's folder against a base
// (HEAD, what is not committed; or a branch, as /diff <branch> names), file by
// file. A click on a line opens a comment there; Send (⌘⏎, which also saves an
// open comment) hands every comment to Claude in one prompt, each with its
// file, line and the line itself. The latest code review's findings show under
// their lines (above the file's rows, for a line the diff does not show), each
// with "Fix this one".

type DiffFile = { path: string; status: string; patch: string; cut?: boolean };
type Row = { kind: 'hunk' | 'add' | 'del' | 'same' | 'note'; text: string; old?: number; new?: number };
type Note = { file: string; line: number; side: 'new' | 'old'; code: string; text: string };

// bindertui's diffRows: a unified diff's rows, numbered.
export function diffRows(patch: string): Row[] {
  const rows: Row[] = [];
  let o = 0;
  let n = 0;
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      rows.push({ kind: 'hunk', text: h[3].trim() });
    } else if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), new: n++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), old: o++ });
    else if (line.startsWith(' ')) rows.push({ kind: 'same', text: line.slice(1), old: o++, new: n++ });
    else if (line.startsWith('\\')) continue;
    else if (line) rows.push({ kind: 'note', text: line });
  }
  return rows;
}

/** The prompt the comments become. */
export function reviewPrompt(base: string, notes: Note[]): string {
  const parts = notes.map((n) => `${n.file}:${n.line}${n.side === 'old' ? ' (a removed line)' : ''}\n> ${n.code}\n${n.text}`);
  return `My comments on the changes (against ${base}). Please address each:\n\n${parts.join('\n\n')}`;
}

const key = (file: string, side: string, line: number) => `${file}\u0000${side}\u0000${line}`;

// A finding under its line, or (with `place`) above its file's rows.
function FindingNote({ f, place, asked, onFix }: { f: Finding; place?: boolean; asked: boolean; onFix: () => void }) {
  return (
    <div className={`diff-finding ${f.severity ?? ''}`}>
      <span className={`sev ${f.severity ?? ''}`}>{severityName(f.severity) || 'finding'}</span>
      {place && f.line ? <span className="line">line {f.line}</span> : null}
      <div className="text">
        <Markdown text={f.summary} />
      </div>
      <button disabled={asked} onClick={onFix}>
        {asked ? 'Asked' : 'Fix this one'}
      </button>
    </div>
  );
}

export function DiffPane({ conn, close, onSent, review, initialBase }: { conn: string; close: () => void; onSent: () => void; review?: { tabId: number; turn: number; findings: Finding[] } | null; initialBase?: string }) {
  const [, redraw] = useState(0);
  const asked = (f: Finding) => Boolean(review && wasAsked({ conn, tabId: review.tabId, turn: review.turn }, f));
  const fix = (f: Finding) => review && void askToFix({ conn, tabId: review.tabId, turn: review.turn }, [f]).then(() => redraw((n) => n + 1));
  const [base, setBase] = useState<string | null>(initialBase || null);
  const [branchList, setBranches] = useState<string[]>([]);
  const [diff, setDiff] = useState<{ base: string; files: DiffFile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Map<string, Note>>(new Map());
  const [editing, setEditing] = useState<{ k: string; note: Omit<Note, 'text'> } | null>(null);
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    request(conn, 'branches').then((r) => setBranches((r.branches as string[]) ?? []), () => {});
  }, [conn]);
  useEffect(() => {
    setDiff(null);
    setError(null);
    request(conn, 'diff', base ? { base } : {})
      .then((r) => setDiff({ base: String(r.base), files: (r.files as DiffFile[]) ?? [] }))
      .catch((e) => setError(errText(e)));
  }, [conn, base]);
  useEffect(() => box.current?.focus(), []);

  const files = useMemo(() => (diff?.files ?? []).map((f) => ({ ...f, rows: diffRows(f.patch) })), [diff]);
  const send = (all = notes) => {
    if (!all.size || !diff) return;
    request(conn, 'send', { text: reviewPrompt(diff.base, [...all.values()]) })
      .then(() => {
        toast(`Sent ${all.size} comment${all.size === 1 ? '' : 's'} to Claude`);
        onSent();
      })
      .catch((e) => toast(errText(e), true));
  };
  // The comments with the one being written; for ⌘⏎, which sends them at once.
  const saveDraft = () => {
    if (!editing) return notes;
    const next = new Map(notes);
    if (draft.trim()) next.set(editing.k, { ...editing.note, text: draft.trim() });
    else next.delete(editing.k);
    setNotes(next);
    setEditing(null);
    setDraft('');
    box.current?.focus();
    return next;
  };
  const open = (file: string, r: Row) => {
    const side = r.kind === 'del' ? 'old' : 'new';
    const line = side === 'old' ? r.old! : r.new!;
    const k = key(file, side, line);
    setEditing({ k, note: { file, line, side, code: r.text } });
    setDraft(notes.get(k)?.text ?? '');
  };

  return (
    <div
      className="diff-pane"
      ref={box}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !editing) return e.preventDefault(), close();
        if (e.key === 'Enter' && e.metaKey) return e.preventDefault(), send();
      }}
    >
      <div className="diff-pane-head">
        <span className="title">Changes</span>
        <label>
          against{' '}
          <select value={base ?? diff?.base ?? 'HEAD'} onChange={(e) => setBase(e.target.value)}>
            <option value="HEAD">HEAD (not committed)</option>
            {base && base !== 'HEAD' && !branchList.includes(base) && <option value={base}>{base}</option>}
            {branchList.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <span className="note">{diff ? `${diff.files.length} file${diff.files.length === 1 ? '' : 's'}` : error ? '' : 'Reading…'}</span>
        <button className="send" disabled={!notes.size} onClick={() => send()} title="⌘⏎">
          Send {notes.size || ''} comment{notes.size === 1 ? '' : 's'}
        </button>
        <button onClick={close} title="Esc">
          ×
        </button>
      </div>
      <div className="diff-pane-body">
        {error && <div className="banner">{error}</div>}
        {diff && !diff.files.length && <div className="note">No changes against {diff.base}.</div>}
        {files.map((f) => {
          const mine = (review?.findings ?? []).filter((x) => samePath(x.file, f.path));
          const lines = new Set(f.rows.filter((r) => r.kind !== 'del' && r.new !== undefined).map((r) => r.new));
          return (
          <div key={f.path} className="diff-file">
            <div className="diff-file-head">
              {f.path} <span className="status">{f.status}{f.cut ? ', cut short' : ''}</span>
            </div>
            {mine
              .filter((x) => !x.line || !lines.has(x.line))
              .map((x, i) => (
                <FindingNote key={i} f={x} place asked={asked(x)} onFix={() => fix(x)} />
              ))}
            <div className="diff">
              {f.rows.map((r, i) => {
                // Nothing skipped above a hunk that starts at line 1.
                if (r.kind === 'hunk' && (f.rows[i + 1]?.new ?? f.rows[i + 1]?.old) === 1) return null;
                if (r.kind === 'hunk' || r.kind === 'note') return <div key={i} className="diff-row skip">⋯ {r.text}</div>;
                const side = r.kind === 'del' ? 'old' : 'new';
                const k = key(f.path, side, side === 'old' ? r.old! : r.new!);
                const note = notes.get(k);
                return (
                  <Fragment key={i}>
                    <div className={`diff-row ${r.kind} commentable${note ? ' noted' : ''}`} onClick={() => open(f.path, r)} title="Click to comment on this line">
                      <span className="num">{r.new ?? r.old}</span>
                      <span className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
                      <span className="code">{r.text || ' '}</span>
                    </div>
                    {editing?.k === k ? (
                      <div className="diff-comment editing">
                        <textarea
                          autoFocus
                          value={draft}
                          placeholder="Comment for Claude (Enter saves, Esc cancels)"
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter' && e.metaKey) return e.preventDefault(), send(saveDraft());
                            if (e.key === 'Enter' && !e.shiftKey) return e.preventDefault(), saveDraft();
                            if (e.key === 'Escape') return e.preventDefault(), setEditing(null), box.current?.focus();
                          }}
                        />
                      </div>
                    ) : note ? (
                      <div className="diff-comment" onClick={() => open(f.path, r)}>
                        {note.text}
                      </div>
                    ) : null}
                    {r.kind !== 'del' &&
                      mine
                        .filter((x) => x.line === r.new)
                        .map((x, j) => <FindingNote key={`f${j}`} f={x} asked={asked(x)} onFix={() => fix(x)} />)}
                  </Fragment>
                );
              })}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
