import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { readClipboardImage, type ClipboardImage } from '../clipboardImage.js';
import * as ed from './editor.js';
import { matchCommands, type SlashCommand } from '../slashCommands.js';
import { commonPrefix, completeCommand, completePath, wordAt } from '../complete.js';
import { glimmerAt, keywordColors, SWEEP_MS, ultrathinkRanges } from './ultrathink.js';
import { copyText, readClipboardText } from '../openUrl.js';
import { shortcutColumns, Shortcuts } from './Shortcuts.js';

export type Attachment = ClipboardImage & { id: number };

type Props = {
  // followup: Ctrl+Enter, send into the current tab instead of a new one.
  onSubmit: (text: string, images: ClipboardImage[], followup: boolean) => void;
  isActive: boolean;
  placeholder?: string;
  width: number;
  initialValue?: string;
  commands?: SlashCommand[];
  // Earlier prompts in this directory, oldest first, for Up/Down.
  history?: string[];
  // Where relative paths complete from.
  cwd?: string;
  // The menu or the shortcuts opened or closed (App leaves Esc to them while open).
  onMenuChange?: (open: boolean) => void;
  // Text was selected or deselected (App leaves Ctrl+C to it while selected).
  onSelectionChange?: (selected: boolean) => void;
};

// A menu row: what replaces value[start, end) when it is picked. Slash
// commands run on Enter (unless they need an argument); paths only fill in.
type MenuItem = { key: string; label: string; description?: string; start: number; end: number; text: string; run?: boolean; needsArg?: boolean };

const MENU_ROWS = 8;
// Longer pastes show as "[Pasted text #1 +40 lines]", as in Claude Code.
const PASTE_INLINE_CHARS = 800;
const PASTE_INLINE_BREAKS = 2;
const THINK_NOTICE = 'Deeper reasoning requested for this turn';

// Multi-line prompt editor with macOS-style keyboard selection.
//   Enter submits; Ctrl+Enter submits into the current tab (the terminal must
//   report it, see renderOptions.ts); Alt+Enter or a trailing backslash inserts a newline.
//   Shift+arrows select; Option+arrows move by word; Home/End (Ctrl+A/E) line ends.
//   Up/Down walk the prompt history from the first/last line.
//   Ctrl+V attaches the clipboard image as "[Image #n]", like Claude Code.
//   Typing "/" opens the command menu and "@" a file menu: Up/Down pick, Tab
//   or Enter takes the pick, Esc closes. Tab completes paths (and commands
//   after "!"); with several matches it fills the common part, then lists them.
export function PromptInput({ onSubmit, isActive, placeholder, width, initialValue, commands = [], history = [], cwd = process.cwd(), onMenuChange, onSelectionChange }: Props) {
  const [e, setE] = useState<ed.Editor>(() => (initialValue ? ed.insert(ed.empty, initialValue) : ed.empty));
  const [images, setImages] = useState<Attachment[]>([]);
  const [pastes, setPastes] = useState<{ label: string; text: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // The menu's highlighted row, the text Esc closed it for, and a Tab
  // completion list, each tied to the text it was made for so typing resets it.
  const [pick, setPick] = useState({ value: '', index: 0 });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ value: string; items: MenuItem[] } | null>(null);
  // Browsing history: how far back, and the unsent text to come back to.
  const [hist, setHist] = useState<{ index: number; draft: string } | null>(null);
  // "?" on an empty prompt shows the shortcuts until the next key.
  const [shortcuts, setShortcuts] = useState(false);

  const { start: wordStart, word } = wordAt(e.value, e.cursor);
  const atPaths = useMemo(() => (word.startsWith('@') ? completePath(word.slice(1), cwd, 50) : []), [word, cwd]);

  let items: MenuItem[] = [];
  const slash = matchCommands(commands, e.value);
  if (slash.length) {
    items = slash.map((c) => ({
      key: c.name,
      label: `/${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''}`,
      description: c.description,
      start: 0,
      end: e.value.length,
      text: `/${c.name}`,
      run: true,
      needsArg: c.argumentHint?.startsWith('<'),
    }));
  } else if (atPaths.length) {
    items = atPaths.map((p) => ({ key: p, label: '@' + p, start: wordStart, end: e.cursor, text: '@' + p }));
  } else if (tabMenu?.value === e.value) {
    items = tabMenu.items;
  }
  if (!isActive || dismissed === e.value) items = [];
  const menuOpen = items.length > 0;
  const showShortcuts = shortcuts && isActive && !e.value;
  const picked = pick.value === e.value ? Math.min(pick.index, items.length - 1) : 0;
  useEffect(() => {
    onMenuChange?.(menuOpen || showShortcuts);
    return () => onMenuChange?.(false); // also when a rewind remounts the prompt
  }, [menuOpen, showShortcuts, onMenuChange]);
  const selected = isActive && ed.selection(e) !== null;
  useEffect(() => {
    onSelectionChange?.(selected);
    return () => onSelectionChange?.(false);
  }, [selected, onSelectionChange]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 1500);
  };

  // "ultrathink" shows in rainbow letters with a band sweeping across them,
  // and a notice says the turn gets deeper reasoning, as in Claude Code.
  const think = useMemo(() => ultrathinkRanges(e.value), [e.value]);
  const sweeping = think.length > 0 && isActive;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!sweeping) return;
    const t = setInterval(() => setTick((n) => n + 1), SWEEP_MS);
    return () => clearInterval(t);
  }, [sweeping]);
  useEffect(() => {
    const clear = () => setNotice((n) => (n === THINK_NOTICE ? null : n));
    if (!think.length) {
      clear();
      return;
    }
    setNotice(THINK_NOTICE);
    const t = setTimeout(clear, 5000);
    return () => clearTimeout(t);
  }, [think.length]);

  // A terminal paste or Ctrl+V text. Functional updates: Ctrl+V lands after
  // an await, when `e` may be stale.
  const pasteText = (raw: string) => {
    const text = raw.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const breaks = text.split('\n').length - 1;
    if (text.length <= PASTE_INLINE_CHARS && breaks <= PASTE_INLINE_BREAKS) return setE((cur) => ed.insert(cur, text));
    const id = pastes.length + 1;
    const label = breaks ? `[Pasted text #${id} +${breaks} lines]` : `[Pasted text #${id}]`;
    setPastes((cur) => cur.concat({ label, text }));
    setE((cur) => ed.insert(cur, label));
  };
  usePaste(pasteText, { isActive });

  const submit = (state: ed.Editor, followup = false) => {
    if (!state.value.trim()) return;
    // Only send images whose placeholder is still in the text.
    const kept = images.filter((img) => state.value.includes(`[Image #${img.id}]`)).map(({ id: _id, ...img }) => img);
    // Pasted text goes in place of its placeholder (split/join: no $ patterns).
    const text = pastes.reduce((v, p) => v.split(p.label).join(p.text), state.value);
    onSubmit(text, kept, followup);
    setE(ed.empty);
    setImages([]);
    setPastes([]);
    setHist(null);
  };

  // Ctrl+V: the clipboard image as "[Image #n]", else the clipboard text.
  const pasteClipboard = async () => {
    const img = await readClipboardImage();
    if (!img) {
      const text = await readClipboardText();
      return text ? pasteText(text) : flash('the clipboard is empty');
    }
    const id = images.length ? Math.max(...images.map((i) => i.id)) + 1 : 1;
    setImages(images.concat({ ...img, id }));
    setE((cur) => ed.insert(cur, `[Image #${id}]`));
  };

  // Tab with no menu: complete the word before the cursor.
  const completeWord = () => {
    if (!word) return;
    const bashCommand = e.value.startsWith('!') && wordStart === 0;
    const candidates = bashCommand
      ? completeCommand(word.slice(1)).map((c) => '!' + c)
      : word.startsWith('@')
        ? completePath(word.slice(1), cwd).map((p) => '@' + p)
        : completePath(word, cwd);
    if (!candidates.length) return flash('no completions');
    const replace = (text: string) => setE(ed.replaceRange(e, wordStart, e.cursor, text));
    if (candidates.length === 1) return replace(candidates[0] + (candidates[0].endsWith('/') ? '' : ' '));
    const common = commonPrefix(candidates);
    if (common.length > word.length) return replace(common);
    setTabMenu({ value: e.value, items: candidates.map((c) => ({ key: c, label: c, start: wordStart, end: e.cursor, text: c })) });
  };

  const recall = (index: number, draft: string) => {
    setHist(index < 0 ? null : { index, draft });
    setE(ed.insert(ed.empty, index < 0 ? draft : history[history.length - 1 - index]));
  };

  useInput(
    (input, key) => {
      // Any key closes the shortcuts; Esc and "?" do nothing else.
      if (showShortcuts) {
        setShortcuts(false);
        if (key.escape || input === '?') return;
      } else if (input === '?' && !e.value) {
        return setShortcuts(true);
      }
      // Ctrl+C copies the selection, as in Claude Code. Cmd+C too where the
      // terminal passes it on (iTerm2 keeps it for its own mouse selection).
      const sel = ed.selection(e);
      if (sel && input === 'c' && (key.ctrl || key.super)) {
        copyText(e.value.slice(sel.start, sel.end));
        return flash('copied to clipboard');
      }
      if (menuOpen) {
        const item = items[picked];
        const move = (d: number) => setPick({ value: e.value, index: (picked + d + items.length) % items.length });
        if (key.upArrow) return move(-1);
        if (key.downArrow) return move(1);
        if (key.escape) return setDismissed(e.value);
        if (key.tab || (key.return && !key.meta)) {
          const fill = (text: string) => setE(ed.replaceRange(e, item.start, item.end, text));
          if (!item.run) return fill(item.text + (key.tab && !item.text.endsWith('/') ? ' ' : ''));
          // Tab, or Enter on a command that needs an argument, fills it in for typing the rest.
          if (key.tab || (item.needsArg && e.value !== item.text)) return fill(item.text + ' ');
          return submit(ed.insert(ed.empty, item.text), key.ctrl);
        }
      }
      // Ink hands fast "text + Enter" sequences over as one chunk with return
      // unset (AppleScript "write text", some terminals' paste-and-enter).
      if (input.length > 1 && /[\r\n]$/.test(input) && !key.meta) {
        submit(ed.insert(e, input.replace(/[\r\n]+$/, '')));
        return;
      }
      if (key.return || (input === '\n' && !key.meta)) {
        if (key.meta) setE(ed.insert(e, '\n'));
        else if (key.ctrl && key.return) submit(e, true);
        else if (e.value.endsWith('\\') && e.cursor === e.value.length && !ed.selection(e)) {
          setE({ value: e.value.slice(0, -1) + '\n', cursor: e.value.length, anchor: null });
        } else submit(e);
        return;
      }
      if (key.backspace) return setE(ed.deleteBackward(e, key.meta));
      if (key.delete) return setE(ed.deleteForward(e, key.meta));
      if (key.tab && !key.shift) return completeWord();

      // Up/Down: between lines of a multi-line prompt, else through history.
      if (key.upArrow || key.downArrow) {
        const moved = ed.moveLine(e, key.upArrow ? -1 : 1, key.shift);
        if (moved) return setE(moved);
        if (key.shift) return;
        if (key.upArrow && (hist?.index ?? -1) + 1 < history.length) return recall((hist?.index ?? -1) + 1, hist?.draft ?? e.value);
        if (key.downArrow && hist) return recall(hist.index - 1, hist.draft);
        return;
      }

      // Movement. Shift extends the selection. Ctrl+arrows switch tabs (handled by App).
      if (key.ctrl && (key.leftArrow || key.rightArrow)) return;
      const wordLeft = key.meta && (key.leftArrow || input === 'b');
      const wordRight = key.meta && (key.rightArrow || input === 'f');
      if (wordLeft) return setE(ed.moveTo(e, ed.prevWord(e.value, e.cursor), key.shift));
      if (wordRight) return setE(ed.moveTo(e, ed.nextWord(e.value, e.cursor), key.shift));
      if (key.leftArrow) return setE(ed.moveChar(e, -1, key.shift));
      if (key.rightArrow) return setE(ed.moveChar(e, 1, key.shift));
      if (key.home || (key.ctrl && input === 'a')) return setE(ed.moveTo(e, ed.lineStart(e.value, e.cursor), key.shift));
      if (key.end || (key.ctrl && input === 'e')) return setE(ed.moveTo(e, ed.lineEnd(e.value, e.cursor), key.shift));

      if (key.ctrl && input === 'v') {
        void pasteClipboard();
        return;
      }
      if (key.ctrl && input === 'u') {
        setE(ed.empty);
        setImages([]);
        setPastes([]);
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) return;
      if (input) setE(ed.insert(e, input));
    },
    { isActive },
  );

  const { value, cursor } = e;
  const sel = ed.selection(e);
  const at = value.slice(cursor, cursor + 1) || ' ';
  // Rows the text occupies once wrapped, so long prompts are not clipped. Ink
  // wraps by word, moving a word that does not fit to the next row, so wrap
  // what is drawn (prompt sign and cursor cell included) the way Ink does.
  const drawn = sel || !isActive ? value : value.slice(0, cursor) + (at === '\n' ? ' \n' : at) + value.slice(cursor + 1);
  const rows = wrapAnsi('❯ ' + drawn, width, { trim: false, hard: true }).split('\n').length;

  const colors = think.length ? keywordColors(value.length, think, sweeping ? glimmerAt(think, tick) : undefined) : undefined;
  // value[a, b), in runs of one color.
  const paint = (a: number, b: number) => {
    const runs: React.ReactNode[] = [];
    for (let i = a; i < b; ) {
      let j = i + 1;
      while (j < b && colors?.[j] === colors?.[i]) j++;
      runs.push(<Text key={i} color={colors?.[i]}>{value.slice(i, j)}</Text>);
      i = j;
    }
    return runs;
  };

  let body: React.ReactNode;
  if (sel) {
    body = (
      <>
        {paint(0, sel.start)}
        <Text inverse color="#7CC4FF">{value.slice(sel.start, sel.end)}</Text>
        {paint(sel.end, value.length)}
      </>
    );
  } else {
    body = (
      <>
        {paint(0, cursor)}
        {isActive ? <Text inverse>{at === '\n' ? ' ' : at}</Text> : <Text color={colors?.[cursor]}>{at === ' ' ? '' : at}</Text>}
        {at === '\n' && isActive ? '\n' : ''}
        {paint(cursor + 1, value.length)}
      </>
    );
  }

  // The menu window scrolls to keep the highlighted row in view.
  const first = Math.max(0, Math.min(picked - MENU_ROWS + 1, items.length - MENU_ROWS));
  const shown = items.slice(first, first + MENU_ROWS);
  const labelWidth = Math.min(32, Math.max(0, ...shown.map((i) => i.label.length))) + 3;
  // Bash mode, like Claude Code's: a pink "!" prompt.
  const bashMode = value.startsWith('!');

  const shortcutCols = showShortcuts ? shortcutColumns(width) : [];

  return (
    <Box flexDirection="column" height={Math.min(8, rows + (notice ? 1 : 0)) + shown.length + (shortcutCols[0]?.length ?? 0)}>
      <Text>
        <Text color={!isActive ? 'gray' : bashMode ? '#FF79C6' : 'cyan'} bold>{bashMode ? '! ' : '❯ '}</Text>
        {!value && placeholder ? (
          // The cursor sits on the placeholder's first letter, where typing starts.
          isActive ? (
            <>
              <Text inverse>{placeholder[0]}</Text>
              <Text dimColor>{placeholder.slice(1)}</Text>
            </>
          ) : (
            <Text dimColor>{placeholder}</Text>
          )
        ) : value || isActive ? (
          body
        ) : null}
      </Text>
      {notice ? <Text dimColor>{notice}</Text> : null}
      {showShortcuts ? <Shortcuts columns={shortcutCols} /> : null}
      {shown.map((item, i) => {
        const selected = first + i === picked;
        return (
          <Text key={item.key} wrap="truncate-end">
            <Text color={selected ? '#7CC4FF' : undefined} bold={selected}>{'  ' + (item.label + '  ').padEnd(labelWidth)}</Text>
            {item.description ? <Text color={selected ? '#7CC4FF' : undefined} dimColor={!selected}>{item.description}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
