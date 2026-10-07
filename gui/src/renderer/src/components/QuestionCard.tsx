import { useEffect, useRef, useState } from 'react';
import type { WireQuestion } from '@shared/wire';

// AskUserQuestion and permission prompts, in place of the prompt box:
// Up/Down move, a number picks, Space toggles in multi-select, Enter
// confirms, Esc denies a permission. "Other" lets you type an answer.
// While `active` the card takes these keys wherever focus is, so a click
// elsewhere in the window never leaves the question unanswerable.

const OTHER = 'Other (type your own)';

function inputSummary(toolName: string | undefined, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const a = input as Record<string, unknown>;
  if (toolName === 'Bash' && typeof a.command === 'string') return a.command;
  if (typeof a.file_path === 'string') return a.file_path;
  return JSON.stringify(input, null, 2);
}

export function QuestionCard({ question, active, onAnswer, onDeny }: { question: WireQuestion; active: boolean; onAnswer: (answers: Record<string, string>) => void; onDeny?: () => void }) {
  const [qi, setQi] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [typing, setTyping] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const other = useRef<HTMLInputElement>(null);

  const q = question.questions[qi];
  const labels = q.options.map((o) => o.label).concat(question.kind === 'ask' ? [OTHER] : []);

  // Focus follows the card only while it has the keyboard, so it never takes it from an open panel.
  useEffect(() => {
    if (!active) return;
    if (typing === null) box.current?.focus();
    else other.current?.focus();
  }, [typing, qi, active]);

  const finish = (label: string) => {
    const next = { ...answers, [q.question]: label };
    if (qi + 1 < question.questions.length) {
      setAnswers(next);
      setQi(qi + 1);
      setCursor(0);
      setPicked(new Set());
      setTyping(null);
    } else onAnswer(next);
  };

  const choose = (i: number) => {
    if (labels[i] === OTHER) return setTyping('');
    if (!q.multiSelect) return finish(labels[i]);
    const chosen = labels.filter((l, j) => (picked.has(j) || j === i) && l !== OTHER);
    finish(chosen.join(', '));
  };

  const toggle = (i: number) => {
    const next = new Set(picked);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setPicked(next);
  };

  const keyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (typing !== null) {
      if (e.key === 'Enter' && typing.trim()) finish(typing.trim());
      else if (e.key === 'Escape') setTyping(null);
      else {
        // Typing while focus is elsewhere goes to the answer box.
        if (e.target !== other.current && e.key.length === 1 && !e.metaKey && !e.ctrlKey) other.current?.focus();
        return;
      }
      e.preventDefault();
      return;
    }
    let handled = true;
    const digit = Number(e.key);
    if (e.key === 'ArrowUp') setCursor((cursor - 1 + labels.length) % labels.length);
    else if (e.key === 'ArrowDown') setCursor((cursor + 1) % labels.length);
    else if (e.key === 'Escape') {
      if (onDeny) onDeny();
      else handled = false;
    } else if (!e.metaKey && !e.ctrlKey && digit >= 1 && digit <= labels.length) {
      setCursor(digit - 1);
      if (!q.multiSelect || labels[digit - 1] === OTHER) choose(digit - 1);
    } else if (e.key === ' ' && q.multiSelect) toggle(cursor);
    else if (e.key === 'Enter') choose(cursor);
    else handled = false;
    if (handled) e.preventDefault();
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

  const detail = question.kind === 'permission' ? inputSummary(question.toolName, question.toolInput) : '';
  return (
    <div className="question" ref={box} tabIndex={-1}>
      <div className="head">
        {q.header && <span className="header">{q.header}</span>}
        <span className="q">{q.question}</span>
        {question.questions.length > 1 && <span className="count">{`${qi + 1}/${question.questions.length}`}</span>}
      </div>
      {question.reason && <div className="reason">{question.reason}</div>}
      {detail && <pre className="tool-input">{detail}</pre>}
      {labels.map((label, i) => {
        const desc = q.options[i]?.description;
        const mark = q.multiSelect ? (picked.has(i) ? '◉' : '○') : i === cursor ? '❯' : '';
        return (
          <div
            key={label}
            className={`option${i === cursor ? ' cursor' : ''}${label === OTHER ? ' other' : ''}`}
            onMouseMove={() => i !== cursor && setCursor(i)}
            onClick={() => (q.multiSelect && label !== OTHER ? toggle(i) : choose(i))}
          >
            <span className="mark">{mark}</span>
            <span className="n">{i + 1}.</span>
            <span className="label">{label}</span>
            {desc && <span className="desc">{desc}</span>}
          </div>
        );
      })}
      {typing !== null && <input ref={other} className="other-input" value={typing} placeholder="Type your answer, then Enter" onChange={(e) => setTyping(e.target.value)} />}
      <div className="hint">
        {typing !== null ? 'Enter sends · Esc goes back' : q.multiSelect ? '↑↓ move · space toggles · ⏎ confirms' : '↑↓ move · ⏎ or a number selects'}
        {onDeny && typing === null ? ' · esc denies' : ''}
      </div>
    </div>
  );
}
