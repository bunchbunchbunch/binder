import { prLine, type PrStatus, type WireState } from '@shared/wire';
import { modelDisplayName, shortPath } from '../lib/format';

// Permission modes: the badge, and what it means for someone new to Claude Code.
// In the order the permission mode picker lists them.
export const PERMISSION_MODES: Record<string, [string, string]> = {
  default: ['manual', 'Claude asks before it edits files or runs commands'],
  acceptEdits: ['accept edits', 'Claude edits files without asking; it still asks before running other tools'],
  plan: ['plan mode', 'Claude reads and plans but changes nothing until you approve the plan'],
  auto: ['auto mode', 'A classifier approves or refuses the tools Claude would ask about'],
  dontAsk: ["don't ask", 'Tools that would need your permission are refused instead of asking'],
  bypassPermissions: ['bypass permissions', 'Claude runs every tool, including commands and edits, without asking'],
};

function Meter({ label, w }: { label: string; w?: { utilization: number; resetsAt: number } }) {
  if (!w) return null;
  const pct = Math.round(w.utilization * 100);
  // resetsAt is in seconds since the epoch.
  const resets = new Date(w.resetsAt * (w.resetsAt < 1e12 ? 1000 : 1));
  return (
    <span className="meter" title={`${label} limit: ${pct}% used, resets ${resets.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}>
      <span>{label}</span>
      <span className="bar">
        <span className={`fill${pct >= 80 ? ' high' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span>{pct}%</span>
    </span>
  );
}

/**
 * The PR badge: its class and what follows "PR #12". Failing checks or a
 * review asking for changes are red, running checks gold, passing ones green;
 * no checks, or only skipped ones, neutral.
 */
export function prBadge(pr: PrStatus): { tone: 'merged' | 'failing' | 'pending' | 'passing' | 'neutral'; mark: string } {
  const c = pr.checks;
  if (pr.state === 'MERGED') return { tone: 'merged', mark: 'merged' };
  const mark = c.failing.length ? `✗ ${c.failing.length}` : c.pending ? '◐' : c.passing ? '✓' : '';
  if (c.failing.length || pr.review === 'CHANGES_REQUESTED') return { tone: 'failing', mark };
  return { tone: c.pending ? 'pending' : c.passing ? 'passing' : 'neutral', mark };
}

// Under the prompt: where and what is running, the permission mode, the
// context (`text`, from config.json's statusText), and the account's usage. A
// click on the folder, the model, the effort level or the permission mode
// opens its picker; on the context, its breakdown.
export function StatusBar({ s, text, onPick, onFast }: { s: WireState; text: string; onPick: (panel: 'cd' | 'model' | 'effort' | 'mode' | 'context' | 'pr') => void; onFast: () => void }) {
  const model = modelDisplayName(s.model);
  const mode = s.permissionMode ? PERMISSION_MODES[s.permissionMode] : undefined;
  const pr = s.pr ? prBadge(s.pr) : null;
  return (
    <div className="statusbar">
      <div className="left">
        <span className="cwd pick" title={`${s.cwd}\nClick to move the session to another folder (/cd)`} onClick={() => onPick('cd')}>
          {shortPath(s.cwd)}
        </span>
        {model && (
          <span className="picks">
            <span className="pick model" title="Change the model (⌃L)" onClick={() => onPick('model')}>
              {model}
            </span>
            {s.effort && (
              <>
                ·
                <span className="pick effort" title="Change the effort level (⇧Tab steps to the next)" onClick={() => onPick('effort')}>
                  {s.effort}
                </span>
              </>
            )}
          </span>
        )}
        {mode && (
          <span className={`badge ${s.permissionMode}`} title={`${mode[1]}. Click to change it.`} onClick={() => onPick('mode')}>
            {mode[0]}
          </span>
        )}
        {s.pr && pr && s.pr.state !== 'CLOSED' && (
          <span
            className={`badge pr ${pr.tone}`}
            title={`${prLine(s.pr)}\n${s.pr.title}\nClick for its checks, a fix, or merge when ready (/pr).`}
            onClick={() => onPick('pr')}
          >
            PR #{s.pr.number}{pr.mark && ` ${pr.mark}`}
          </span>
        )}
        {(s.fastMode === 'on' || s.fastMode === 'cooldown') && (
          <span className={`badge fast ${s.fastMode}`} title={`${s.fastMode === 'on' ? 'Fast mode is on' : 'Fast mode is paused after a rate limit and comes back on by itself'}. Click to turn it off (⌥O).`} onClick={onFast}>
            {s.fastMode === 'on' ? '↯ fast' : '↯ fast (paused)'}
          </span>
        )}
      </div>
      <div className="right">
        {text ? (
          <span
            className="ctx pick"
            title={`${s.contextTokens ? `How much of the conversation Claude is holding: ${s.contextTokens.toLocaleString()}${s.contextWindow ? ` of ${s.contextWindow.toLocaleString()}` : ''} tokens in the latest request. ` : ''}Click for the breakdown. Settings (⌘,) changes what shows here.`}
            onClick={() => onPick('context')}
          >
            {text}
          </span>
        ) : null}
        <Meter label="5h" w={s.usage?.five_hour} />
        <Meter label="7d" w={s.usage?.seven_day} />
      </div>
    </div>
  );
}
