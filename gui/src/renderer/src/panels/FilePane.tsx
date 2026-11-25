import { useEffect, useMemo, useRef, useState } from 'react';
import { errText, request, toast, useApp } from '../store';
import { highlight } from '../components/Markdown';
import { langOf } from '../components/Blocks';
import { Picker, type PickerItem } from '../components/Picker';
import { plural } from '../lib/format';
import { fileEndings, indentEdit, lfText } from '../lib/files';

// The file pane (⌘P, /open): the session folder's files over the session, a
// tree on the left and a file on the right, highlighted; Edit (config.json
// fileEditing) turns it into a text box that ⌘S saves. A file Claude changed
// while it is open (and not being edited) is read again when the turn ends;
// a save over a file changed on disk since it was read asks first. A save keeps
// the file's line endings. Everything goes through the host, so a session on
// another computer works the same.

type Entry = { name: string; dir: boolean };
type FileText = { path: string; size: number; mtime: number; text?: string; binary?: true };

// Past this, a file shows as plain text: highlighting it would hang the pane.
const HIGHLIGHT_MAX = 300 * 1024;
const QUICK_MAX = 200;
const DISCARD_MS = 2000;

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Quick open's ranking: the name starting with the query, then containing it, then the path containing it, then its letters in order. */
export function rankFiles(files: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, QUICK_MAX);
  const scored: [number, string][] = [];
  for (const f of files) {
    const path = f.toLowerCase();
    const name = baseOf(path);
    let score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : path.includes(q) ? 2 : -1;
    if (score < 0) {
      let i = 0;
      for (const ch of path) if (ch === q[i]) i++;
      if (i < q.length) continue;
      score = 3;
    }
    scored.push([score * 10000 + Math.min(path.length, 9999), f]);
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, QUICK_MAX)
    .map(([, f]) => f);
}

function QuickOpen({ conn, onOpen, onCancel }: { conn: string; onOpen: (path: string) => void; onCancel: () => void }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    request(conn, 'file_index').then(
      (r) => setFiles((r.files as string[]) ?? []),
      (e) => {
        toast(errText(e), true);
        setFiles([]);
      },
    );
  }, [conn]);
  const items: PickerItem[] = useMemo(() => rankFiles(files ?? [], query).map((f) => ({ key: f, label: baseOf(f), description: parentOf(f) || undefined })), [files, query]);
  return (
    <Picker
      title="Open a file"
      subtitle={files ? `${plural(files.length, 'file')} in the session folder` : 'Listing the files…'}
      items={items}
      search={{ query, onChange: setQuery, placeholder: 'Type part of its name or path' }}
      empty={files ? 'No file matches' : 'Listing the files…'}
      onSelect={(item) => onOpen(item.key)}
      onCancel={onCancel}
    />
  );
}

export function FilePane({ conn, close, path, quick, running, local, cwd }: { conn: string; close: () => void; path?: string; quick?: boolean; running: boolean; local: boolean; cwd: string }) {
  const editable = useApp((st) => st.fileEditing);
  const [dirs, setDirs] = useState<Map<string, Entry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [file, setFile] = useState<FileText | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [finding, setFinding] = useState(Boolean(quick));
  const discardArmed = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const dirty = draft !== null && draft !== lfText(file?.text ?? '');

  const loadDir = (dir: string) =>
    request(conn, 'file_list', { dir }).then(
      (r) => setDirs((m) => new Map(m).set(dir, (r.entries as Entry[]) ?? [])),
      (e) => toast(errText(e), true),
    );
  // `focus`: give the pane the keyboard (not for a reload at a turn's end, which leaves it where it is).
  const open = (p: string, focus = true) =>
    request(conn, 'file_read', { path: p }).then(
      (r) => {
        const f = r as unknown as FileText;
        setFile(f);
        setDraft(null);
        setConflict(false);
        // Its folders open in the tree.
        const parts = f.path.split('/').slice(0, -1);
        const chain = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
        setExpanded((s) => new Set([...s, ...chain]));
        for (const d of chain) void loadDir(d);
        if (focus) box.current?.focus();
      },
      (e) => toast(errText(e), true),
    );

  useEffect(() => {
    void loadDir('');
    if (path) void open(path);
    else box.current?.focus();
  }, [conn]);
  useEffect(() => {
    if (path && path !== file?.path) void open(path);
  }, [path]);
  // A turn that ends may have changed the file and the folders: read them again, unless being edited.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      for (const d of expanded) void loadDir(d);
      if (file && draft === null) void open(file.path, false);
    }
    wasRunning.current = running;
  }, [running]);

  const toggle = (dir: string) => {
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      void loadDir(dir);
    }
    setExpanded(next);
  };
  const save = (force = false) => {
    if (!file || draft === null) return;
    if (!editable) return toast('File editing is off (Settings, ⌘,): this pane no longer saves files', true);
    const text = fileEndings(draft, file.text ?? '');
    request(conn, 'file_write', { path: file.path, text, mtime: file.mtime, force }).then(
      (r) => {
        setFile({ ...file, text, mtime: Number(r.mtime), size: Number(r.size) });
        setConflict(false);
        toast(`Saved ${file.path}`);
      },
      (e) => {
        const msg = errText(e);
        if (/changed on disk/.test(msg)) setConflict(true);
        else toast(msg, true);
      },
    );
  };

  // Back from editing; unsaved edits go only when asked twice.
  const leaveEdit = () => {
    if (!dirty || Date.now() - discardArmed.current < DISCARD_MS) {
      setDraft(null);
      setConflict(false);
      box.current?.focus();
      return;
    }
    discardArmed.current = Date.now();
    toast('Unsaved changes: ⌘S saves them; Esc (or Discard) again drops them');
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (finding) return;
    if (e.metaKey && e.key === 's') return e.preventDefault(), save();
    if (e.metaKey && e.key === 'p') return e.preventDefault(), setFinding(true);
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (draft !== null) return leaveEdit();
    close();
  };

  // While editing, the draft's lines.
  const shownText = draft ?? file?.text;
  const lines = shownText === undefined ? 0 : shownText.split('\n').length - (shownText.endsWith('\n') ? 1 : 0);
  const html = useMemo(() => (file?.text === undefined ? '' : file.text.length > HIGHLIGHT_MAX ? highlight(file.text) : highlight(file.text, langOf(file.path))), [file]);

  const tree = (dir: string, depth: number): React.ReactNode =>
    (dirs.get(dir) ?? []).map((e) => {
      const p = dir ? `${dir}/${e.name}` : e.name;
      if (!e.dir) {
        return (
          <div key={p} className={`tree-row file${file?.path === p ? ' current' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => void open(p)} title={p}>
            {e.name}
          </div>
        );
      }
      const isOpen = expanded.has(p);
      return (
        <div key={p}>
          <div className="tree-row dir" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(p)} title={p}>
            <span className="chev">{isOpen ? '▾' : '▸'}</span>
            {e.name}
          </div>
          {isOpen && tree(p, depth + 1)}
        </div>
      );
    });

  return (
    <div className="file-pane" ref={box} tabIndex={-1} onKeyDown={onKey}>
      <div className="file-pane-head">
        <span className="title">Files</span>
        <span className="path">{file ? file.path : cwd}</span>
        <span className="note">
          {file ? (file.binary ? `binary, ${plural(file.size, 'byte')}` : `${plural(lines, 'line')}${dirty ? ' · edited' : ''}`) : ''}
        </span>
        <button onClick={() => setFinding(true)} title="⌘P">
          Find a file
        </button>
        {file && local && (
          <button onClick={() => window.binder.openPath(file.path, cwd, 'edit').catch((e) => toast(errText(e), true))} title="In config.json's editor">
            Open in editor
          </button>
        )}
        {file?.text !== undefined && draft === null && editable && (
          <button className="edit" onClick={() => setDraft(lfText(file.text!))}>
            Edit
          </button>
        )}
        {draft !== null && (
          <button className="save" disabled={!dirty} onClick={() => save()} title="⌘S">
            Save
          </button>
        )}
        {draft !== null && (
          <button onClick={leaveEdit} title="Esc">
            {dirty ? 'Discard' : 'Done'}
          </button>
        )}
        <button onClick={close} title="Esc">
          ×
        </button>
      </div>
      {conflict && (
        <div className="banner file-conflict">
          {file?.path} changed on disk since you opened it.
          <button onClick={() => file && void open(file.path)}>Reload it (drop your edits)</button>
          <button onClick={() => save(true)}>Save over it</button>
        </div>
      )}
      <div className="file-pane-body">
        <div className="file-tree">{tree('', 0)}</div>
        <div className="file-view">
          {!file ? (
            <div className="note">Pick a file on the left, or ⌘P to find one.</div>
          ) : file.binary ? (
            <div className="note">A binary file ({plural(file.size, 'byte')}): nothing to show here.</div>
          ) : draft !== null ? (
            <textarea
              className="file-edit"
              value={draft}
              spellCheck={false}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Tab indents (with a tab where the file uses tabs): at the caret, or each selected line; Shift+Tab outdents.
                if (e.key !== 'Tab' || e.metaKey || e.ctrlKey) return;
                e.preventDefault();
                const t = e.currentTarget;
                const r = indentEdit(t.value, t.selectionStart, t.selectionEnd, /^\t/m.test(draft) ? '\t' : '  ', e.shiftKey);
                if (!r) return;
                // Typed in, so ⌘Z takes it back.
                t.setSelectionRange(r.from, r.to);
                document.execCommand('insertText', false, r.insert);
                t.setSelectionRange(r.start, r.end);
                setDraft(t.value);
              }}
            />
          ) : (
            <div className="file-code">
              <pre className="gutter">{Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n')}</pre>
              <pre className="code">
                <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
              </pre>
            </div>
          )}
        </div>
      </div>
      {finding && (
        <QuickOpen
          conn={conn}
          onOpen={(p) => {
            setFinding(false);
            void open(p);
          }}
          onCancel={() => {
            setFinding(false);
            // Opened by ⌘P with nothing picked: nothing to stay for.
            if (!file && quick) close();
            else box.current?.focus();
          }}
        />
      )}
    </div>
  );
}
