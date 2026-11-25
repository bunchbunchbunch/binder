import { memo } from 'react';
import { HostImage } from './Images';
import type { WireTab, WireTurn } from '@shared/wire';
import { fmtDuration, plural } from '../lib/format';
import { lastToolIndex, RAINBOW, splitWork, ultrathinkParts, workSummary } from '../lib/work';
import { Blocks, type BlockCtx } from './Blocks';
import { FindingsCard } from './FindingsCard';
import { turnFindings } from '../lib/findings';
import { useApp } from '../store';
import type { WireBlock } from '@shared/wire';

// One tab: each turn's prompt, its work (folded into a summary once the
// response lands, unless expanded), the response, and follow-ups waiting
// to be sent into this tab.

// `auto`: binder's own follow-up about background work another tab's turn took in.
export type PendingPrompt = { prompt: string; sending: boolean; auto?: boolean };

// Edit (in the prompt below) and Remove for a prompt of this tab still in the queue.
export type QueueControls = { edit: (prompt: string) => void; remove: (prompt: string) => void };

function QueuedActions({ prompt, queued }: { prompt: string; queued: QueueControls }) {
  return (
    <span className="queued-actions">
      <button onClick={() => queued.edit(prompt)}>Edit</button>
      <button onClick={() => queued.remove(prompt)}>Remove</button>
    </span>
  );
}

export function PromptText({ text }: { text: string }) {
  return (
    <>
      {ultrathinkParts(text).map((p, i) =>
        p.rainbow ? (
          <span key={i} className="rainbow">
            {[...p.text].map((ch, j) => (
              <span key={j} style={{ color: RAINBOW[j % RAINBOW.length] }}>
                {ch}
              </span>
            ))}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

// `pinned`: the prompt is held in the sticky header instead.
// `index`: the turn's place among the tab's turns, oldest first (how the host finds its images).
function Turn({ turn, index, expanded, onToggle, ctx, latest, pinned, queued }: { turn: WireTurn; index: number; expanded: boolean; onToggle: () => void; ctx: BlockCtx; latest: boolean; pinned?: boolean; queued?: QueueControls }) {
  const { work, response } = splitWork(turn.blocks);
  // Expanded, the work keeps the text written between tool calls in place.
  const split = lastToolIndex(turn.blocks) + 1;
  // A code review's findings show as a card, in place of the review's text.
  const findingsCard = useApp((st) => st.findingsCard);
  const found = findingsCard && turn.status !== 'running' ? turnFindings(turn) : null;
  const shown = (bs: WireBlock[]) => (found?.fromText ? bs.filter((b) => b !== found.block) : bs);
  return (
    <div className="turn" data-turn data-latest={latest || undefined}>
      {turn.auto ? (
        <div className="auto-head">⏺ {turn.prompt}</div>
      ) : (
        !pinned && (
          <div className={`prompt${turn.bash ? ' bash' : ''}`}>
            <PromptText text={turn.prompt} />
          </div>
        )
      )}
      {/* Images sent with the prompt, under it (also while the prompt itself is pinned above the tabs). */}
      {turn.images?.length ? (
        <div className="prompt-images">
          {turn.images.map((img, i) => (
            <HostImage key={i} img={img} at={{ conn: ctx.conn, session: ctx.session, tabId: ctx.tabId, turn: index, index: i }} />
          ))}
        </div>
      ) : null}
      {work.length > 0 && (
        <button className={`work-toggle${expanded ? ' open' : ''}`} onClick={onToggle} data-work={latest || undefined}>
          <span className="chev">▶</span>
          {workSummary(work)}
          <kbd>⌃E</kbd>
        </button>
      )}
      {expanded && work.length > 0 ? (
        <>
          <div className="work">
            <Blocks blocks={shown(turn.blocks.slice(0, split))} ctx={ctx} />
          </div>
          <Blocks blocks={shown(turn.blocks.slice(split))} ctx={ctx} />
        </>
      ) : (
        <Blocks blocks={shown(expanded ? turn.blocks : response)} ctx={ctx} />
      )}
      {found && <FindingsCard findings={found.findings} review={{ conn: ctx.conn, tabId: ctx.tabId, turn: index, cwd: ctx.cwd, local: ctx.local }} />}
      {turn.status === 'queued' && (
        <div className="turn-note">
          Queued, waiting for the current turn to finish
          {queued && <QueuedActions prompt={turn.prompt} queued={queued} />}
        </div>
      )}
      {turn.status === 'interrupted' && <div className="turn-note warn">Interrupted</div>}
      {turn.result && turn.status !== 'interrupted' && turn.status !== 'superseded' && (
        <div className={`turn-note${turn.status === 'error' ? ' error' : ''}`}>
          {turn.status === 'error' ? 'Error · ' : ''}
          {fmtDuration(turn.result.durationMs)}
          {turn.result.numTurns > 1 ? ` · ${plural(turn.result.numTurns, 'step')}` : ''}
        </div>
      )}
    </div>
  );
}

type Props = {
  tab: WireTab;
  ctx: BlockCtx;
  // The latest turn's work is expanded; earlier turns' work only with `expandEarlier`.
  expanded: boolean;
  expandEarlier: boolean;
  onToggle: () => void;
  pending: PendingPrompt[];
  // The turn whose prompt the sticky header holds (config.json stickyPrompt).
  pinned: WireTurn | null;
  queued: QueueControls;
};

function TranscriptImpl({ tab, ctx, expanded, expandEarlier, onToggle, pending, pinned, queued }: Props) {
  return (
    <div className="transcript">
      {tab.earlier.map((turn, i) => (
        <Turn key={i} turn={turn} index={i} expanded={expandEarlier} onToggle={onToggle} ctx={ctx} latest={false} pinned={turn === pinned} />
      ))}
      <Turn turn={tab} index={tab.earlier.length} expanded={expanded} onToggle={onToggle} ctx={ctx} latest pinned={tab === pinned} queued={queued} />
      {pending.map((p, i) =>
        p.auto ? (
          <div key={i} className="turn">
            <div className="auto-head pending">⏺ {p.prompt}</div>
            <div className="turn-note">Claude carries on with it here once the current turn ends</div>
          </div>
        ) : (
          <div key={i} className="turn">
            <div className="prompt pending">
              <PromptText text={p.prompt} />
            </div>
            <div className="turn-note pending-note">
              {p.sending ? (
                'Sending now…'
              ) : (
                <>
                  Queued; sends into this tab when the current turn finishes
                  <QueuedActions prompt={p.prompt} queued={queued} />
                </>
              )}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

export const Transcript = memo(TranscriptImpl);
