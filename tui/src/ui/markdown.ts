import { renderMarkdown as render } from './md/render.js';

// Render markdown to ANSI for a given width. Falls back to the raw text if
// the renderer throws on a partial document.
export function renderMarkdown(text: string, width: number): string {
  try {
    return render(text, width);
  } catch {
    return text;
  }
}
