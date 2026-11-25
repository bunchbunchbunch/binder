// Shared by the main process and the window: what a dev server printed, read
// for the address to preview (main/preview.ts, components/PreviewPane.tsx).

/** The first http(s) URL with a port in a dev server's output (ANSI and all), 0.0.0.0 and [::] read as localhost; null before it prints one. */
export function serverUrl(output: string): string | null {
  // eslint-disable-next-line no-control-regex
  const text = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+):\d+[^\s'"`)<>]*/.exec(text);
  return m ? m[0].replace(/\/\/(0\.0\.0\.0|\[::\]):/, '//localhost:').replace(/[.,;]+$/, '') : null;
}

/** What /preview was given: a web address (or a bare port, or host:port), else a command that starts the server. */
export function previewTarget(arg: string): { url: string } | { command: string } | null {
  const a = arg.trim();
  if (!a) return null;
  if (/^\d{2,5}$/.test(a)) return { url: `http://localhost:${a}/` };
  if (/^([\w.-]+|\[[\da-f:]*\]):\d+(\/\S*)?$/i.test(a)) return { url: `http://${a.replace(/^(0\.0\.0\.0|\[::\]):/, 'localhost:')}` };
  if (/^https?:\/\/\S+$/i.test(a)) return { url: a };
  return { command: a };
}
