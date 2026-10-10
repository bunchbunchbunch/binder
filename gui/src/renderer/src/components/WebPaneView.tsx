import { useEffect, useRef, useState } from 'react';
import { errText } from '../store';

// A web pane: a page from config.json's `panes` with a `url`. The main
// process shows it in a view of its own drawn over the window, so this holds
// its place: it reports where its box is and whether the page shows (on
// screen, under no panel, since the view would cover the panel). A page that
// did not load shows its error here instead, where Enter loads it again or
// opens a link on its origin (a sign-in link) first.

export function WebPaneView({ name, visible, focus }: { name: string; visible: boolean; focus: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [started, setStarted] = useState(false);
  // Why the page did not load; null while it shows.
  const [error, setError] = useState<string | null>(null);
  // Under the link field: loading, or why a link was refused.
  const [note, setNote] = useState<string | null>(null);
  const [link, setLink] = useState('');

  useEffect(() => {
    const off = window.binder.onWebPane((n, e) => {
      if (n !== name) return;
      setNote(null);
      setError(e.t === 'failed' ? e.error : null);
    });
    window.binder.webPaneStart(name).then(
      (why) => {
        setError(why);
        setStarted(true);
      },
      (e) => setError(errText(e)),
    );
    return off;
  }, [name]);

  const show = focus && started && error === null;
  useEffect(() => {
    if (!started) return;
    const el = box.current!;
    const place = () => {
      const r = el.getBoundingClientRect();
      window.binder.webPaneLayout(name, { x: r.x, y: r.y, width: r.width, height: r.height }, show);
    };
    place();
    // The box moves with the window's size and the sidebar's width (dragged or hidden with ⌃⌘S).
    const resized = new ResizeObserver(place);
    resized.observe(el);
    window.addEventListener('resize', place);
    return () => {
      resized.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [name, started, show]);

  useEffect(() => {
    if (focus && error !== null) field.current?.focus();
  }, [focus, error]);

  const load = (url?: string) => {
    setNote('Loading…');
    // A sign-in link carries a secret: it does not stay on screen.
    setLink('');
    window.binder.webPaneLoad(name, url).catch((e) => setNote(errText(e)));
  };

  return (
    <div className={`pane${visible ? '' : ' off'}`}>
      <div className="titlebar">
        <span className="pane-title">{name}</span>
      </div>
      <div className="pane-web" ref={box}>
        {error !== null && (
          <div className="banner">
            <span className="err">The page did not load.</span> {error}
            <input
              ref={field}
              className="pane-link"
              value={link}
              placeholder="Open a link in this pane (a sign-in link)"
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                load(link.trim() || undefined);
              }}
            />
            <div className="turn-note">
              {note ?? (
                <>
                  <kbd>⏎</kbd> tries again, or opens the link first
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
