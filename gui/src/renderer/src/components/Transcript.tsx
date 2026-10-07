import { memo } from 'react';
import type { WireTab, WireTurn } from '@shared/wire';
import { fmtDuration, plural } from '../lib/format';
import { lastToolIndex, RAINBOW, splitWork, ultrathinkParts, workSummary } from '../lib/work';
import { Blocks, type BlockCtx } from './Blocks';

// One tab: each turn's prompt, its work (folded into a summary once the
// response lands, unless expanded), the response, and follow-ups waiting
// to be sent into this tab.

export type PendingPrompt = { prompt: string; sending: boolean };

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
function Turn({ turn, expanded, onToggle, ctx, latest, pinned, queued }: { turn: WireTurn; expanded: boolean; onToggle: () => void; ctx: BlockCtx; latest: boolean; pinned?: boolean; queued?: QueueControls }) {
  const { work, response } = splitWork(turn.blocks);
  // Expanded, the work keeps the text written between tool calls in place.
  const split = lastToolIndex(turn.blocks) + 1;
  return (
    <div className="turn" data-turn data-latest={latest || undefined}>
      {!pinned && (
        <div className={`prompt${turn.bash ? ' bash' : ''}`}>
          <PromptText text={turn.prompt} />
        </div>
      )}
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
            <Blocks blocks={turn.blocks.slice(0, split)} ctx={ctx} />
          </div>
          <Blocks blocks={turn.blocks.slice(split)} ctx={ctx} />
        </>
      ) : (
        <Blocks blocks={expanded ? turn.blocks : response} ctx={ctx} />
      )}
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
  // The latest prompt is in the sticky header (config.json stickyPrompt).
  pinned: boolean;
  queued: QueueControls;
};

function TranscriptImpl({ tab, ctx, expanded, expandEarlier, onToggle, pending, pinned, queued }: Props) {
  return (
    <div className="transcript">
      {tab.earlier.map((turn, i) => (
        <Turn key={i} turn={turn} expanded={expandEarlier} onToggle={onToggle} ctx={ctx} latest={false} />
      ))}
      <Turn turn={tab} expanded={expanded} onToggle={onToggle} ctx={ctx} latest pinned={pinned} queued={queued} />
      {pending.map((p, i) => (
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
      ))}
    </div>
  );
}

export const Transcript = memo(TranscriptImpl);
