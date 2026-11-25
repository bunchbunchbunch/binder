import React, { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { Question } from '../store.js';
import { clean } from './md/text.js';
import { PLAN_FEEDBACK } from '../permissions.js';

// What a permission prompt is asking to run, shown in full so the approval is
// of the real command, not just "Allow Bash?". Mirrors the Mac app's card.
function permissionDetail(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if (toolName === 'Bash' && typeof input.command === 'string') return clean(input.command);
  if (typeof input.file_path === 'string') return clean(input.file_path);
  return clean(JSON.stringify(input, null, 2));
}

// A workflow's card: what it is and its phases, not its script.
function workflowDetail(w: NonNullable<Question['workflow']>): string {
  const lines = [w.description ? clean(w.description) : '', w.phases.length ? `Phases: ${w.phases.map(clean).join(' → ')}` : ''].filter(Boolean);
  return lines.join('\n') || 'A workflow script';
}

type Props = {
  question: Question;
  onAnswer: (answers: Record<string, string>) => void;
  onDeny?: () => void;
};

const OTHER = 'Other (type your own)';

// Renders AskUserQuestion prompts (and plain allow/deny permission prompts)
// as a selectable list. Up/Down move, Space toggles in multi-select, Enter
// confirms the current question, Esc denies.
export function QuestionView({ question, onAnswer, onDeny }: Props) {
  const [qi, setQi] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [typing, setTyping] = useState<string | null>(null);
  const { columns } = useWindowSize();

  const q = question.questions[qi];
  // AskUserQuestion takes a typed answer; a plan, typed changes to make.
  const plan = question.plan !== undefined;
  const typed = question.toolUseId ? OTHER : plan ? PLAN_FEEDBACK : undefined;
  const labels = q.options.map((o) => o.label).concat(typed ? [typed] : []);
  // Permission prompts show the exact command or input; a plan is in the transcript above.
  const detail = question.toolUseId || plan ? '' : question.workflow ? workflowDetail(question.workflow) : permissionDetail(question.toolName, question.toolInput);

  const finish = (label: string) => {
    const next = { ...answers, [q.question]: label };
    if (qi + 1 < question.questions.length) {
      setAnswers(next);
      setQi(qi + 1);
      setCursor(0);
      setPicked(new Set());
      setTyping(null);
    } else {
      onAnswer(next);
    }
  };

  useInput((input, key) => {
    if (typing !== null) {
      if (key.return) {
        if (typing.trim()) finish(typing.trim());
        return;
      }
      if (key.escape) return setTyping(null);
      if (key.backspace || key.delete) return setTyping(typing.slice(0, -1));
      if (key.ctrl || key.meta || !input) return;
      // Text and Enter in one chunk (a paste, or fast typing) is typed, then sent.
      const text = typing + input.replace(/[\r\n]+$/, '');
      if (/[\r\n]$/.test(input) && text.trim()) return finish(text.trim());
      setTyping(text);
      return;
    }
    if (key.upArrow) return setCursor((cursor - 1 + labels.length) % labels.length);
    if (key.downArrow) return setCursor((cursor + 1) % labels.length);
    if (key.escape) return onDeny?.();
    const digit = Number(input);
    if (input && digit >= 1 && digit <= labels.length) {
      setCursor(digit - 1);
      if (labels[digit - 1] === typed) return setTyping('');
      if (!q.multiSelect) return finish(labels[digit - 1]);
    }
    if (input === ' ' && q.multiSelect) {
      const next = new Set(picked);
      if (next.has(cursor)) next.delete(cursor);
      else next.add(cursor);
      return setPicked(next);
    }
    if (key.return) {
      if (labels[cursor] === typed) return setTyping('');
      if (q.multiSelect) {
        const chosen = labels.filter((_, i) => picked.has(i) || i === cursor).filter((l) => l !== typed);
        return finish(chosen.join(', '));
      }
      finish(labels[cursor]);
    }
  });

  const labelWidth = Math.max(...labels.map((l) => l.length));
  // Descriptions sit beside the labels when every one fits (the border,
  // padding, mark, number and gaps take about 14 columns), else each goes
  // under its label rather than wrapping back to the left edge.
  const longest = Math.max(0, ...q.options.map((o) => o.description?.length ?? 0));
  const beside = labelWidth + longest + 14 <= columns;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#C9A0FF" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="#FFD580" bold>{q.header ? `${clean(q.header)}  ` : ''}</Text>
        <Text bold>{clean(q.question)}</Text>
        {question.questions.length > 1 ? <Text dimColor>  ({qi + 1}/{question.questions.length})</Text> : null}
      </Box>
      {detail ? (
        <Box marginBottom={1} borderStyle="round" borderColor="#4A6A8A" paddingX={1}>
          <Text>{detail}</Text>
        </Box>
      ) : null}
      {plan ? (
        <Box marginBottom={1}>
          <Text dimColor>The plan is above (PgUp scrolls back through it).</Text>
        </Box>
      ) : null}
      {question.reason ? (
        <Box marginBottom={1}>
          <Text color="#E8C07D">{clean(question.reason)}</Text>
        </Box>
      ) : null}
      {labels.map((label, i) => {
        const desc = q.options[i]?.description;
        const selected = i === cursor;
        const mark = q.multiSelect ? (picked.has(i) ? '◉' : '○') : selected ? '❯' : ' ';
        const pad = ' '.repeat(3 + String(i + 1).length + 3);
        return (
          <Box key={label} flexDirection="column">
            <Text>
              <Text color="#7CC4FF">{` ${mark} `}</Text>
              <Text color="#7CC4FF" dimColor={!selected}>{`${i + 1}. `}</Text>
              <Text bold={selected} inverse={selected} color={label === typed ? '#7F848E' : undefined}>{` ${clean(label)} `}</Text>
              {desc && beside ? <Text dimColor>{' '.repeat(Math.max(1, labelWidth - label.length + 1))}{clean(desc)}</Text> : null}
            </Text>
            {desc && !beside ? <Text dimColor>{pad}{clean(desc)}</Text> : null}
          </Box>
        );
      })}
      <Box marginTop={1}>
        {typing !== null ? (
          <Text>
            <Text color="#7CC4FF" bold>{'❯ '}</Text>{typing}<Text inverse> </Text>
          </Text>
        ) : (
          <Text dimColor>{q.multiSelect ? '↑↓ move · space toggles · enter confirms' : '↑↓ move · enter or number selects'}{onDeny ? (question.toolName === 'AskUserQuestion' ? ' · esc declines' : plan ? ' · esc keeps planning' : ' · esc denies') : ''}</Text>
        )}
      </Box>
    </Box>
  );
}
