import { useEffect, useRef, useState } from 'react';
import { errText, request } from '../store';
import { Markdown } from './Markdown';

// /btw: a side chat about the session, above the prompt. Claude answers from
// the conversation so far, without tools, and nothing here goes into the
// transcript (bindertui's side_question request). Its own box asks the next
// question, with the earlier ones as history; Esc or × closes it, and what it
// held goes.

// `id`: the question's own, so its answer finds it.
export type SideItem = { id: number; question: string; response: string | null; error?: string };

let lastId = 0;

/**
 * Asks a side question in `conn`, given the chat so far; `set` updates the
 * chat once it is answered. The answer goes to its own question only: one
 * that lands after the chat closed (or closed and opened again) is dropped.
 */
export function askSide(conn: string, items: SideItem[], question: string, set: (fn: (now: SideItem[] | null) => SideItem[] | null) => void): SideItem[] {
  const history = items.flatMap((it) => (it.response !== null && !it.error ? [{ question: it.question, response: it.response }] : []));
  const id = ++lastId;
  const land = (item: SideItem) => set((now) => now && now.map((it) => (it.id === id ? item : it)));
  request(conn, 'side_question', { question, history }).then(
    (r) => land({ id, question, response: String(r.response ?? '') }),
    (e) => land({ id, question, response: null, error: errText(e) }),
  );
  return [...items, { id, question, response: null }];
}

export function SideChat({ items, onAsk, onClose }: { items: SideItem[]; onAsk: (question: string) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [items]);
  return (
    <div className="side-chat">
      <div className="side-chat-head">
        <span className="title">Side chat</span>
        <span className="dim">answered from the session so far, kept out of its transcript</span>
        <button onClick={onClose} title="Esc">
          ×
        </button>
      </div>
      <div className="side-chat-list" ref={list}>
        {items.map((it, i) => (
          <div key={i} className="side-item">
            <div className="side-q">{it.question}</div>
            {it.error ? <div className="side-error">{it.error}</div> : it.response === null ? <div className="side-wait">Thinking…</div> : <Markdown text={it.response} />}
          </div>
        ))}
      </div>
      <textarea
        ref={box}
        className="side-chat-input"
        rows={1}
        value={text}
        placeholder="A side question (Enter asks, Esc closes)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') return e.preventDefault(), onClose();
          if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
            e.preventDefault();
            onAsk(text.trim());
            setText('');
          }
        }}
      />
    </div>
  );
}
