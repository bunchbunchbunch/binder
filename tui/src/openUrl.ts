import { execFile, spawn } from 'node:child_process';

// Hands a URL to the system browser, or text to and from the clipboard.

export function openExternal(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

export function copyText(text: string): void {
  const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip';
  const args = process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
  const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {});
  child.stdin.end(text);
}

// The clipboard's text, or '' when it holds none.
export function readClipboardText(): Promise<string> {
  const [cmd, args] = process.platform === 'darwin' ? ['pbpaste', []] : ['xclip', ['-selection', 'clipboard', '-o']];
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out));
  });
}
