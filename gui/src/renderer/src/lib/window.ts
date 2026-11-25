import type { SessionRef } from '@shared/api';

// Which window this page is: the main one (null), or a session's own window,
// whose session the main process put in the URL's hash (main/index.ts createWindow).
function read(): SessionRef | null {
  const m = /(?:^#|&)window=([^&]*)/.exec(location.hash);
  if (!m) return null;
  try {
    const ref = JSON.parse(decodeURIComponent(m[1])) as SessionRef;
    return typeof ref.sessionId === 'string' && typeof ref.cwd === 'string' ? ref : null;
  } catch {
    return null;
  }
}

export const windowSession: SessionRef | null = read();
