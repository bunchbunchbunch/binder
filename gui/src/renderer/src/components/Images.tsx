import { useEffect, useState } from 'react';
import type { WireImage } from '@shared/wire';
import { errText, request, useApp } from '../store';

// Images in the transcript: a tool's result (a screenshot, a Read of an image
// file) and the images sent with a prompt. The host sends only their kind and
// size; the bytes come with the `image` request, once each per session.
// config.json showImages false leaves a caption.

const loaded = new Map<string, string>();

/** "PNG image, 45 KB". */
export function imageCaption(img: WireImage): string {
  const kind = (img.mediaType.split('/')[1] ?? 'image').toUpperCase();
  const kb = img.bytes >= 1024 * 1024 ? `${(img.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(img.bytes / 1024))} KB`;
  return `${kind} image, ${kb}`;
}

export type ImageWhere = { conn: string; session: string; tabId: number; index: number } & ({ toolUseId: string } | { turn: number });

export function HostImage({ img, at }: { img: WireImage; at: ImageWhere }) {
  const show = useApp((s) => s.showImages);
  const key = `${at.conn}:${at.session}:${at.tabId}:${'toolUseId' in at ? at.toolUseId : `turn${at.turn}`}:${at.index}`;
  const [src, setSrc] = useState(() => loaded.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!show || src) return;
    const { conn, session: _session, ...where } = at;
    request(conn, 'image', where)
      .then((r) => {
        const url = `data:${String(r.mediaType)};base64,${String(r.data)}`;
        loaded.set(key, url);
        setSrc(url);
      })
      .catch((e) => setError(errText(e)));
  }, [key, show]);
  const caption = imageCaption(img);
  if (!show || !src) return <span className="img-caption" title={error ?? undefined}>▣ {caption}{show && !error ? ' …' : ''}</span>;
  return <img className={`inline-img${big ? ' big' : ''}`} src={src} alt={caption} title={`${caption}. Click to ${big ? 'shrink' : 'enlarge'}.`} onClick={() => setBig(!big)} />;
}

// Web images you asked for, by URL: one stays shown when its turn is drawn
// anew (moving among the tab's earlier turns).
const fetched = new Map<string, string>();

/**
 * A markdown image: a file on this Mac (an absolute path, ~/..., or relative
 * to the session's folder) shows at once; a remote one only when you ask, so
 * showing a response never makes the app fetch a URL by itself.
 */
export function MarkdownImage({ src, alt, cwd, local }: { src: string; alt: string; cwd?: string; local?: boolean }) {
  const show = useApp((s) => s.showImages);
  const [data, setData] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remote = /^https?:/i.test(src);
  const label = `Image: ${alt || src.split('/').pop() || 'untitled'}`;
  useEffect(() => {
    setData(remote && show ? (fetched.get(src) ?? null) : null);
    if (!show || remote || !local || !cwd || !src) return;
    window.binder.localImage(src, cwd).then(setData, (e) => setError(errText(e)));
  }, [src, cwd, show, local]);
  if (data) return <img className="inline-img" src={data} alt={alt} title={src} />;
  if (remote) {
    const host = URL.parse(src)?.host ?? src;
    if (!show) {
      return (
        <a className="md-image" href={src} title={src} onClick={(e) => (e.preventDefault(), void window.binder.openExternal(src))}>
          {label} ({host})
        </a>
      );
    }
    return (
      <button className="md-image" title={error ?? `Load ${src}`} onClick={() => window.binder.fetchImage(src).then((url) => (fetched.set(src, url), setData(url)), (e) => setError(errText(e)))}>
        {label} · load from {host}
      </button>
    );
  }
  return (
    <span className="md-image" title={error ?? src}>
      {label}
    </span>
  );
}
