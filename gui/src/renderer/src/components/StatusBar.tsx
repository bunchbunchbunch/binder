import type { WireState } from '@shared/wire';
import { fmtTokens, modelDisplayName, shortPath } from '../lib/format';

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

// Under the prompt: where and what is running, the permission mode, and the account's usage.
// A click on the folder, the model, the effort level or the permission mode opens its picker.
export function StatusBar({ s, onPick }: { s: WireState; onPick: (panel: 'cd' | 'model' | 'effort' | 'mode') => void }) {
  const model = modelDisplayName(s.model);
  const mode = s.permissionMode ? PERMISSION_MODES[s.permissionMode] : undefined;
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
      </div>
      <div className="right">
        {s.contextTokens ? (
          <span className="ctx" title="How much of the conversation Claude is holding: the prompt size of the latest request">
            {fmtTokens(s.contextTokens)} context
          </span>
        ) : null}
        <Meter label="5h" w={s.usage?.five_hour} />
        <Meter label="7d" w={s.usage?.seven_day} />
      </div>
    </div>
  );
}
