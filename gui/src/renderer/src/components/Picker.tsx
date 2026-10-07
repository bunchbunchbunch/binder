import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type PickerItem = {
  key: string;
  label: string;
  description?: string;
  // Before the label: a status mark, or ✓ for the current choice.
  mark?: string;
  markColor?: string;
};

type Props = {
  title: string;
  items: PickerItem[];
  onSelect: (item: PickerItem) => void;
  onCancel: () => void;
  // Typing edits the query; the caller filters `items` by it.
  search?: { query: string; onChange: (query: string) => void; placeholder?: string };
  hint?: ReactNode;
  subtitle?: ReactNode;
  // Extra keys; return true when handled.
  onKey?: (e: KeyboardEvent, item: PickerItem | undefined) => boolean;
  initial?: number;
  empty?: string;
  // The picker has the keyboard (its session is on screen, under no other panel).
  active?: boolean;
};

// A centered list over the session, for binder's panels (/model, /resume,
// /mcp, ...): Up/Down (PgUp/PgDn) move, Enter picks, Esc closes. While active
// it takes these keys wherever focus is (typing goes to its search box); the
// mouse works too.
export function Picker({ title, items, onSelect, onCancel, search, hint, subtitle, onKey, initial = 0, empty = 'Nothing here', active = true }: Props) {
  const [cursor, setCursor] = useState(initial);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const at = Math.max(0, Math.min(cursor, items.length - 1));
  const item = items[at];

  useEffect(() => {
    if (active) (input.current ?? box.current)?.focus();
  }, [active]);
  useEffect(() => setCursor(initial), [initial]);
  useLayoutEffect(() => {
    list.current?.querySelector('.picked')?.scrollIntoView({ block: 'nearest' });
  }, [at, items]);

  const keyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (onKey?.(e, item)) return e.preventDefault();
    const page = 8;
    let handled = true;
    if (e.key === 'Escape') onCancel();
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) setCursor(Math.max(0, at - 1));
    else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) setCursor(Math.min(items.length - 1, at + 1));
    else if (e.key === 'PageUp') setCursor(Math.max(0, at - page));
    else if (e.key === 'PageDown') setCursor(Math.min(items.length - 1, at + page));
    else if (e.key === 'Enter') item && onSelect(item);
    else handled = false;
    if (handled) e.preventDefault();
    // Typing while focus is elsewhere goes to the search box.
    else if (search && e.target !== input.current && e.key.length === 1 && !e.metaKey && !e.ctrlKey) input.current?.focus();
  };
  const keys = useRef(keyDown);
  keys.current = keyDown;
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if (!e.defaultPrevented) keys.current(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="picker" ref={box} tabIndex={-1}>
        <div className="picker-head">
          <div className="picker-title">
            {title}
            {items.length > 8 ? <span className="picker-sub" style={{ marginLeft: 8 }}>{`${at + 1}/${items.length}`}</span> : null}
          </div>
          {subtitle ? <div className="picker-sub">{subtitle}</div> : null}
        </div>
        {search ? (
          <input
            ref={input}
            className="picker-search"
            value={search.query}
            placeholder={search.placeholder ?? 'Type to search'}
            onChange={(e) => {
              search.onChange(e.target.value);
              setCursor(0);
            }}
          />
        ) : null}
        <div className="picker-list" ref={list}>
          {items.length ? (
            items.map((it, i) => (
              <div key={it.key} className={`picker-item${i === at ? ' picked' : ''}`} onMouseMove={() => i !== at && setCursor(i)} onClick={() => onSelect(it)}>
                {it.mark !== undefined ? (
                  <span className="mark" style={{ color: i === at ? undefined : it.markColor }}>
                    {it.mark}
                  </span>
                ) : null}
                <span className="label">{it.label}</span>
                {it.description ? <span className="desc">{it.description}</span> : null}
              </div>
            ))
          ) : (
            <div className="picker-empty">{empty}</div>
          )}
        </div>
        <div className="picker-hint">{hint ?? '↑↓ move · ⏎ select · esc close'}</div>
      </div>
    </div>
  );
}

export function ConfirmPanel({ title, question, yes, onAnswer, active }: { title: string; question: string; yes: string; onAnswer: (ok: boolean) => void; active?: boolean }) {
  return (
    <Picker
      active={active}
      title={title}
      subtitle={question}
      items={[
        { key: 'yes', label: yes },
        { key: 'no', label: 'No' },
      ]}
      onSelect={(i) => onAnswer(i.key === 'yes')}
      onCancel={() => onAnswer(false)}
    />
  );
}
