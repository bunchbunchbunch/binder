import { useState } from 'react';
import { findingPlace, fixAllPrompt, fixPrompt, severityCounts, severityName, type Finding } from '../lib/findings';
import { errText, request, toast } from '../store';
import { Markdown } from './Markdown';

// A code review's findings (/code-review; config.json findingsCard), in place
// of the review's text: each with what is wrong, where, and how it fails, and
// "Fix this one"; "Apply fixes" asks for the rest in one prompt. Both go into
// the review's tab.

// `turn`: the review's place among its tab's turns, oldest first.
export type Review = { conn: string; tabId: number; turn: number; cwd: string; local: boolean };

// The findings already sent, by session, tab, review and finding: kept here, as
// the card is drawn anew when its turn moves among the tab's earlier turns, and
// the diff pane shares it. A later review with the same text starts fresh.
const sent = new Set<string>();
const sentKey = (review: Pick<Review, 'conn' | 'tabId' | 'turn'>, f: Finding) => `${review.conn}\0${review.tabId}\0${review.turn}\0${f.file}:${f.line ?? ''}\0${f.summary}`;
export const wasAsked = (review: Pick<Review, 'conn' | 'tabId' | 'turn'>, f: Finding): boolean => sent.has(sentKey(review, f));

/** Asks Claude, in the review's tab, to fix `findings`; resolves true once sent. */
export function askToFix(review: Pick<Review, 'conn' | 'tabId' | 'turn'>, findings: Finding[]): Promise<boolean> {
  const text = findings.length === 1 ? fixPrompt(findings[0]) : fixAllPrompt(findings);
  return request(review.conn, 'send', { text, tabId: review.tabId }).then(
    () => {
      for (const f of findings) sent.add(sentKey(review, f));
      toast(findings.length === 1 ? `Asked Claude to fix ${findingPlace(findings[0])}` : `Asked Claude to fix ${findings.length} findings`);
      return true;
    },
    (e) => {
      toast(errText(e), true);
      return false;
    },
  );
}

export function FindingsCard({ findings, review }: { findings: Finding[]; review: Review }) {
  // Drawn again once a fix is sent.
  const [, redraw] = useState(0);
  const asked = new Set(findings.flatMap((f, i) => (wasAsked(review, f) ? [i] : [])));
  const ask = (which: number[]) => void askToFix(review, which.map((i) => findings[i])).then(() => redraw((n) => n + 1));
  const rest = findings.map((_, i) => i).filter((i) => !asked.has(i));
  const counts = severityCounts(findings);
  return (
    <div className="findings">
      <div className="findings-head">
        <span className="title">Code review</span>
        <span className="dim">
          {findings.length} finding{findings.length === 1 ? '' : 's'}
          {counts ? ` · ${counts}` : ''}
        </span>
        <button className="apply" disabled={!rest.length} onClick={() => ask(rest)} title={rest.length ? `Ask Claude to fix ${rest.length === findings.length ? 'every finding' : 'the rest'} in one prompt` : 'Every finding was sent'}>
          {rest.length === findings.length || !rest.length ? 'Apply fixes' : `Apply the other ${rest.length}`}
        </button>
      </div>
      {findings.map((f, i) => (
        <div key={i} className={`finding ${f.severity ?? ''}`}>
          <div className="finding-head">
            <span className={`sev ${f.severity ?? ''}`}>{severityName(f.severity) || 'finding'}</span>
            <span
              className={`place${review.local ? ' file-link' : ''}`}
              title={review.local ? 'Click to open it in your editor, Option-click to show it in Finder' : undefined}
              onClick={review.local ? (e) => window.binder.openPath(f.file, review.cwd, e.altKey ? 'reveal' : 'edit', f.line).catch((err) => toast(errText(err), true)) : undefined}
            >
              {findingPlace(f)}
            </span>
            <button className="fix" disabled={asked.has(i)} onClick={() => ask([i])}>
              {asked.has(i) ? 'Asked' : 'Fix this one'}
            </button>
          </div>
          <Markdown text={f.summary} />
          {f.scenario && <div className="scenario">Failure scenario: {f.scenario}</div>}
        </div>
      ))}
    </div>
  );
}
