import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ImageAttachment } from './claudeProcess.js';

// What a prompt can carry besides its text: images, PDFs (a `document` block
// Claude reads) and text files (their text, fenced). The limits are the API's
// for images and PDFs, and a sane one for text.

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
// Text files by extension; anything else must at least decode as UTF-8 without NULs.
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.sh', '.zsh', '.bash', '.sql', '.log', '.ini', '.cfg', '.conf', '.env.example', '.tex', '.rst', '.svg']);

export const LIMITS = { image: 5 * 1024 * 1024, pdf: 32 * 1024 * 1024, text: 512 * 1024 };

export const isImage = (a: ImageAttachment) => a.mediaType.startsWith('image/');
export const isPdf = (a: ImageAttachment) => a.mediaType === 'application/pdf';

/** How the prompt names an attachment: "[Image #1]", or "[File #2: notes.pdf]". */
export const attachmentLabel = (a: ImageAttachment, n: number) => (isImage(a) ? `[Image #${n}]` : `[File #${n}: ${a.name ?? 'file'}]`);

const looksLikeText = (b: Buffer) => !b.subarray(0, 8192).includes(0) && !b.toString('utf8').includes('�');

/** A file on disk as an attachment, or why it cannot be one. */
export function attachFile(path: string): ImageAttachment | string {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return `Not a file: ${path}`;
    size = st.size;
  } catch {
    return `No such file: ${path}`;
  }
  const name = basename(path);
  const ext = extname(path).toLowerCase();
  const image = IMAGE_TYPES[ext];
  try {
    if (image) return size > LIMITS.image ? `${name} is over 5 MB, the most an image can be` : { mediaType: image, data: readFileSync(path).toString('base64'), name };
    if (ext === '.pdf') return size > LIMITS.pdf ? `${name} is over 32 MB, the most a PDF can be` : { mediaType: 'application/pdf', data: readFileSync(path).toString('base64'), name };
    if (size > LIMITS.text) return `${name} is over 512 KB; attach a smaller file, or mention it with @ so Claude reads it`;
    const body = readFileSync(path);
    if (!TEXT_EXTS.has(ext) && !looksLikeText(body)) return `${name} is not an image, a PDF or text; mention it with @ so Claude reads it`;
    return { mediaType: 'text/plain', data: body.toString('base64'), name };
  } catch (e) {
    // Unreadable (no permission): said, not thrown into the prompt's key handler.
    return `Cannot read ${name}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`;
  }
}

// A fence longer than any run of backticks in the text.
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

/** The content blocks a prompt's attachments become in Claude Code's stream-json. */
export function attachmentBlocks(attachments: ImageAttachment[]): object[] {
  return attachments.map((a) => {
    if (isImage(a)) return { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } };
    if (isPdf(a)) return { type: 'document', source: { type: 'base64', media_type: a.mediaType, data: a.data }, ...(a.name && { title: a.name }) };
    const text = Buffer.from(a.data, 'base64').toString('utf8');
    const f = fence(text);
    return { type: 'text', text: `Attached file ${a.name ?? ''}:\n\n${f}\n${text}\n${f}` };
  });
}

/**
 * Pasted paths (what iTerm2 types for dropped files: spaces escaped, a space
 * after each), each as typed and as a path, if the text is nothing but paths.
 */
export function pastedPaths(text: string): Array<{ text: string; path: string }> | null {
  const t = text.trim();
  // On one line, bare spaces part the paths; escaped ones are in them.
  const words = t.split(/(?<!\\) +/);
  if (!t || t.includes('\n') || !words.every((w) => w.startsWith('/') || w.startsWith('~/'))) return null;
  return words.map((w) => ({ text: w, path: w.replace(/\\(.)/g, '$1').replace(/^~(?=\/)/, process.env.HOME ?? '~') }));
}
