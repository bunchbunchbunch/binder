import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Question } from '../store.js';

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

  const q = question.questions[qi];
  const labels = q.options.map((o) => o.label).concat(question.toolUseId ? [OTHER] : []);

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
      if (!key.ctrl && !key.meta && input) setTyping(typing + input);
      return;
    }
    if (key.upArrow) return setCursor((cursor - 1 + labels.length) % labels.length);
    if (key.downArrow) return setCursor((cursor + 1) % labels.length);
    if (key.escape) return onDeny?.();
    const digit = Number(input);
    if (input && digit >= 1 && digit <= labels.length) {
      setCursor(digit - 1);
      if (!q.multiSelect) return finish(labels[digit - 1]);
    }
    if (input === ' ' && q.multiSelect) {
      const next = new Set(picked);
      if (next.has(cursor)) next.delete(cursor);
      else next.add(cursor);
      return setPicked(next);
    }
    if (key.return) {
      if (labels[cursor] === OTHER) return setTyping('');
      if (q.multiSelect) {
        const chosen = labels.filter((_, i) => picked.has(i) || i === cursor).filter((l) => l !== OTHER);
        return finish(chosen.join(', '));
      }
      finish(labels[cursor]);
    }
  });

  const labelWidth = Math.max(...labels.map((l) => l.length));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#C9A0FF" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="#FFD580" bold>{q.header ? `${q.header}  ` : ''}</Text>
        <Text bold>{q.question}</Text>
        {question.questions.length > 1 ? <Text dimColor>  ({qi + 1}/{question.questions.length})</Text> : null}
      </Box>
      {question.reason ? (
        <Box marginBottom={1}>
          <Text color="#E8C07D">{question.reason}</Text>
        </Box>
      ) : null}
      {labels.map((label, i) => {
        const desc = q.options[i]?.description;
        const selected = i === cursor;
        const mark = q.multiSelect ? (picked.has(i) ? '◉' : '○') : selected ? '❯' : ' ';
        return (
          <Text key={label}>
            <Text color="#7CC4FF">{` ${mark} `}</Text>
            <Text color="#7CC4FF" dimColor={!selected}>{`${i + 1}. `}</Text>
            <Text bold={selected} inverse={selected} color={label === OTHER ? '#7F848E' : undefined}>{` ${label} `}</Text>
            {desc ? <Text dimColor>{' '.repeat(Math.max(1, labelWidth - label.length + 1))}{desc}</Text> : null}
          </Text>
        );
      })}
      <Box marginTop={1}>
        {typing !== null ? (
          <Text>
            <Text color="#7CC4FF" bold>{'❯ '}</Text>{typing}<Text inverse> </Text>
          </Text>
        ) : (
          <Text dimColor>{q.multiSelect ? '↑↓ move · space toggles · enter confirms' : '↑↓ move · enter or number selects'}{onDeny ? ' · esc denies' : ''}</Text>
        )}
      </Box>
    </Box>
  );
}
