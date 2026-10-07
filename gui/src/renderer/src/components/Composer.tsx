import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { ImageAttachment } from '@shared/api';
import type { SlashCommand } from '@shared/wire';
import { commonPrefix, matchCommands, wordAt } from '../lib/commands';
import { errText, request } from '../store';
import { Shortcuts } from './Shortcuts';

// The prompt, with the TUI's keys:
//   Enter sends in a new tab; Ctrl+Enter into the current one (send now on a
//   running turn); Shift+Enter, Alt+Enter or a trailing \ make a newline.
//   Up/Down on the first/last line walk this folder's prompt history.
//   "/" opens the command menu and "@" a file menu: Up/Down pick, Tab or
//   Enter takes, Esc closes. Tab completes paths (after "!", commands).
//   On an empty prompt, Tab or Right takes the suggested next prompt and
//   "?" shows the shortcuts. Ctrl+V pastes an image or text; long pastes
//   collapse to "[Pasted text #n +N lines]", as in Claude Code.

export type ComposerHandle = { focus: () => void; setText: (text: string) => void };

type Props = {
  conn: string;
  cwd: string;
  commands: SlashCommand[];
  suggestion?: string | null;
  running: boolean;
  // The prompt has the keyboard (no question or panel is up, and the session is on screen).
  active: boolean;
  // Text the prompt starts with (a session opened with a draft).
  draft?: string;
  onSubmit: (text: string, images: ImageAttachment[], followup: boolean) => void;
};

type MenuItem = { key: string; label: string; description?: string; start: number; end: number; text: string; run?: boolean; needsArg?: boolean };

const PASTE_INLINE_CHARS = 800;
const PASTE_INLINE_BREAKS = 2;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

type Attached = ImageAttachment & { id: number; url: string };

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((done, fail) => {
    const r = new FileReader();
    r.onload = () => done({ mediaType: file.type, data: String(r.result).replace(/^data:[^,]*,/, '') });
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ conn, cwd, commands, suggestion, running, active, draft = '', onSubmit }, ref) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(draft);
  const [cursor, setCursor] = useState(draft.length);
  const [images, setImages] = useState<Attached[]>([]);
  const [pastes, setPastes] = useState<{ label: string; text: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pick, setPick] = useState({ value: '', index: 0 });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ value: string; items: MenuItem[] } | null>(null);
  const [atMenu, setAtMenu] = useState<{ word: string; items: MenuItem[] } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [hist, setHist] = useState<{ index: number; draft: string } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);

  useEffect(() => {
    request(conn, 'history')
      .then((r) => setHistory((r.prompts as string[]) ?? []))
      .catch(() => {});
  }, [conn, cwd]);

  // Where the caret goes when the text is replaced (history, a rewind, a
  // send): applied as the new text commits, before the next key arrives, so
  // fast typing after Enter is never split around a caret that jumps.
  const caret = useRef<number | null>(draft ? draft.length : null);
  const set = (text: string, at = text.length) => {
    setValue(text);
    setCursor(at);
    if (text === value) ta.current?.setSelectionRange(at, at);
    else caret.current = at;
  };

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    setText: (text: string) => {
      set(text);
      ta.current?.focus();
    },
  }));

  useEffect(() => {
    if (active) ta.current?.focus();
  }, [active]);

  // Grow with the text, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    if (caret.current !== null) el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 1500);
  };

  // Typing replaces the selection and keeps the native undo stack.
  const insert = (text: string) => {
    ta.current?.focus();
    document.execCommand('insertText', false, text);
  };
  const replaceRange = (start: number, end: number, text: string) => {
    ta.current?.setSelectionRange(start, end);
    insert(text);
  };

  const { start: wordStart, word } = wordAt(value, cursor);

  // "@" lists files under the session folder as the path is typed.
  useEffect(() => {
    if (!word.startsWith('@')) return;
    let live = true;
    const t = setTimeout(() => {
      request(conn, 'complete', { partial: word.slice(1) })
        .then((r) => {
          if (!live) return;
          const items = ((r.items as string[]) ?? []).map((p) => ({ key: p, label: '@' + p, start: wordStart, end: wordStart + word.length, text: '@' + p }));
          setAtMenu({ word, items });
        })
        .catch(() => {});
    }, 60);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [word, wordStart, conn]);

  let items: MenuItem[] = [];
  const slash = matchCommands(commands, value);
  if (slash.length) {
    items = slash.map((c) => ({
      key: c.name,
      label: `/${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''}`,
      description: c.description,
      start: 0,
      end: value.length,
      text: `/${c.name}`,
      run: true,
      needsArg: c.argumentHint?.startsWith('<'),
    }));
  } else if (word.startsWith('@') && atMenu?.word === word) {
    items = atMenu.items;
  } else if (tabMenu?.value === value) {
    items = tabMenu.items;
  }
  if (!active || dismissed === value) items = [];
  const menuOpen = items.length > 0;
  const picked = pick.value === value ? Math.min(pick.index, items.length - 1) : 0;
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    menuRef.current?.querySelector('.picked')?.scrollIntoView({ block: 'nearest' });
  }, [picked, menuOpen]);

  const showShortcuts = shortcuts && active && !value;

  const pasteText = (raw: string) => {
    const text = raw.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const breaks = text.split('\n').length - 1;
    if (text.length <= PASTE_INLINE_CHARS && breaks <= PASTE_INLINE_BREAKS) return insert(text);
    const id = pastes.length + 1;
    const label = breaks ? `[Pasted text #${id} +${breaks} lines]` : `[Pasted text #${id}]`;
    setPastes((cur) => cur.concat({ label, text }));
    insert(label);
  };

  // Numbered from a counter, so several images attached at once each get their own.
  const nextImage = useRef(1);
  const attach = (img: ImageAttachment) => {
    const id = nextImage.current++;
    setImages((cur) => cur.concat({ ...img, id, url: `data:${img.mediaType};base64,${img.data}` }));
    insert(`[Image #${id}]`);
  };

  const attachFiles = async (files: File[]) => {
    for (const f of files) {
      if (IMAGE_TYPES.test(f.type)) attach(await readImage(f));
      else {
        const path = window.binder.pathForFile(f);
        if (path) insert(`@${path} `);
      }
    }
  };

  // Ctrl+V: the clipboard image as "[Image #n]", else its text.
  const pasteClipboard = async () => {
    const img = await window.binder.clipboardImage();
    if (img) return attach(img);
    const text = await window.binder.clipboardText();
    if (text) pasteText(text);
    else flash('The clipboard is empty');
  };

  const submit = (text: string, followup: boolean) => {
    if (!text.trim()) return;
    const kept = images.filter((img) => text.includes(`[Image #${img.id}]`)).map(({ mediaType, data }) => ({ mediaType, data }));
    // Pasted text goes in place of its placeholder (split/join: no $ patterns).
    const full = pastes.reduce((v, p) => v.split(p.label).join(p.text), text);
    onSubmit(full, kept, followup);
    setHistory((h) => (h[h.length - 1] === full ? h : h.concat(full)));
    set('');
    setImages([]);
    setPastes([]);
    nextImage.current = 1;
    setHist(null);
    setTabMenu(null);
  };

  // Tab with no menu: complete the word before the cursor.
  const completeWord = async () => {
    if (!word) return;
    const bashCommand = value.startsWith('!') && wordStart === 0;
    const at = word.startsWith('@');
    const partial = bashCommand || at ? word.slice(1) : word;
    let found: string[];
    try {
      found = ((await request(conn, 'complete', { partial, ...(bashCommand && { command: true }) })).items as string[]) ?? [];
    } catch (e) {
      return flash(errText(e));
    }
    const candidates = found.map((c) => (bashCommand ? '!' + c : at ? '@' + c : c));
    if (!candidates.length) return flash('No completions');
    const end = wordStart + word.length;
    if (candidates.length === 1) return replaceRange(wordStart, end, candidates[0] + (candidates[0].endsWith('/') ? '' : ' '));
    const common = commonPrefix(candidates);
    if (common.length > word.length) return replaceRange(wordStart, end, common);
    setTabMenu({ value, items: candidates.map((c) => ({ key: c, label: c, start: wordStart, end, text: c })) });
  };

  const recall = (index: number, draft: string) => {
    setHist(index < 0 ? null : { index, draft });
    set(index < 0 ? draft : history[history.length - 1 - index]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const mods = e.ctrlKey || e.metaKey || e.altKey;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // Any key closes the shortcuts; Esc and "?" do nothing else.
    if (showShortcuts) {
      setShortcuts(false);
      if (e.key === 'Escape' || e.key === '?') return handled();
    } else if (e.key === '?' && !value && !mods) {
      setShortcuts(true);
      return handled();
    }
    const hasSelection = el.selectionStart !== el.selectionEnd;
    if (e.ctrlKey && e.key === 'c' && hasSelection) {
      void window.binder.copyText(value.slice(el.selectionStart, el.selectionEnd));
      flash('Copied');
      return handled();
    }
    if (!value && suggestion && ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'ArrowRight' && !mods && !e.shiftKey))) {
      set(suggestion);
      return handled();
    }
    if (menuOpen) {
      const item = items[picked];
      const move = (d: number) => setPick({ value, index: (picked + d + items.length) % items.length });
      if (e.key === 'ArrowUp') return handled(), move(-1);
      if (e.key === 'ArrowDown') return handled(), move(1);
      if (e.key === 'Escape') return handled(), setDismissed(value);
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.altKey)) {
        handled();
        if (!item.run) return replaceRange(item.start, item.end, item.text + (e.key === 'Tab' && !item.text.endsWith('/') ? ' ' : ''));
        // Tab, or Enter on a command that needs an argument, fills it in for typing the rest.
        if (e.key === 'Tab' || (item.needsArg && value !== item.text)) return replaceRange(item.start, item.end, item.text + ' ');
        return submit(item.text, e.ctrlKey);
      }
    }
    if (e.key === 'Enter') {
      handled();
      if (e.shiftKey || e.altKey) return insert('\n');
      if (e.ctrlKey) return submit(value, true);
      if (value.endsWith('\\') && el.selectionStart === value.length && !hasSelection) return replaceRange(value.length - 1, value.length, '\n');
      return submit(value, false);
    }
    if (e.key === 'Tab') {
      handled();
      if (!e.shiftKey && !mods) void completeWord();
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mods && !e.shiftKey) {
      const before = value.slice(0, el.selectionStart);
      const after = value.slice(el.selectionEnd);
      if (e.key === 'ArrowUp' && !before.includes('\n') && (hist?.index ?? -1) + 1 < history.length) return handled(), recall((hist?.index ?? -1) + 1, hist?.draft ?? value);
      if (e.key === 'ArrowDown' && !after.includes('\n') && hist) return handled(), recall(hist.index - 1, hist.draft);
      return;
    }
    if (e.ctrlKey && !e.metaKey && e.key === 'v') return handled(), void pasteClipboard();
    if (e.ctrlKey && !e.metaKey && e.key === 'u') {
      handled();
      set('');
      setImages([]);
      setPastes([]);
      nextImage.current = 1;
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void attachFiles(files);
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    const breaks = text.split('\n').length - 1;
    if (text.length > PASTE_INLINE_CHARS || breaks > PASTE_INLINE_BREAKS) {
      e.preventDefault();
      pasteText(text);
    }
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    void attachFiles([...e.dataTransfer.files]);
  };

  const bash = value.startsWith('!');
  const think = /\bultrathink\b/i.test(value);
  const shownImages = images.filter((img) => value.includes(`[Image #${img.id}]`));
  const placeholder = suggestion || (running ? 'Enter queues a new tab, Ctrl+Enter adds to this one' : 'Ask Claude anything. ? for shortcuts');
  const hint = useMemo(() => {
    if (!value && suggestion) return 'Tab takes the suggestion';
    if (running) return '⏎ new tab · ⌃⏎ send into this one now';
    return '⏎ send in a new tab · ⌃⏎ into this tab · ⇧⏎ newline';
  }, [value, suggestion, running]);

  return (
    <>
      {showShortcuts && <Shortcuts />}
      {menuOpen && (
        <div className="menu" ref={menuRef}>
          {items.slice(0, 200).map((item, i) => (
            <div
              key={item.key}
              className={`menu-item${i === picked ? ' picked' : ''}`}
              onMouseMove={() => i !== picked && setPick({ value, index: i })}
              onMouseDown={(e) => {
                e.preventDefault();
                if (!item.run) replaceRange(item.start, item.end, item.text + (item.text.endsWith('/') ? '' : ' '));
                else if (item.needsArg) replaceRange(item.start, item.end, item.text + ' ');
                else submit(item.text, false);
              }}
            >
              <span className="label">{item.label}</span>
              {item.description && <span className="desc">{item.description}</span>}
            </div>
          ))}
        </div>
      )}
      <div className={`composer${bash ? ' bash' : ''}`} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        {shownImages.length > 0 && (
          <div className="attachments">
            {shownImages.map((img) => (
              <span key={img.id} className="attachment">
                <img src={img.url} alt="" />
                Image #{img.id}
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <span className="sign">{bash ? '!' : '❯'}</span>
          <textarea
            ref={ta}
            rows={1}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value);
              setCursor(e.target.selectionStart);
              setDismissed(null);
            }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        <div className="composer-foot">
          <span className="notice">{notice ?? (think ? 'Deeper reasoning requested for this turn' : bash ? 'Bash mode: runs in the session folder; the model sees the output with your next prompt' : '')}</span>
          <span className="keys">{hint}</span>
        </div>
      </div>
    </>
  );
});
