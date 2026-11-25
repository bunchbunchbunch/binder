import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.js';
import { binderConfig } from './config.js';
import { checkMode } from './permissions.js';
import { startHost } from './remote/start.js';
import { hostRequest } from './remote/hostClient.js';

// Scheduled tasks: a prompt run on a schedule, each run in a fresh session
// (its own headless host, named for the task), with a history of runs. They
// live in binder's state dir; `binder schedule tick` starts the ones due, and
// the Mac app and the terminal app tick every minute while they are open
// (config.json schedules), so a task runs while either is. A lock and each
// task's last run keep two tickers from running it twice.

export type Schedule = {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  // "daily 9:00", "weekdays 17:30", "mon,thu 8:00", "hourly", "every 15m", "every 2h", or a 5-field cron line.
  when: string;
  // The permission mode its sessions start in; else config.json's, else Claude Code's.
  mode?: string;
  paused?: boolean;
  createdAt: number;
  lastRunAt?: number;
};
export type ScheduleRun = { scheduleId: string; name: string; at: number; sessionId?: string; error?: string; manual?: boolean };
type Saved = { schedules: Schedule[]; runs: ScheduleRun[] };

const RUNS_KEPT = 300;
const LOCK_STALE_MS = 10 * 60_000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const fileOf = () => join(stateDir(), 'schedules.json');

export function loadSchedules(): Saved {
  try {
    const s = JSON.parse(readFileSync(fileOf(), 'utf8')) as Partial<Saved>;
    return { schedules: Array.isArray(s.schedules) ? s.schedules : [], runs: Array.isArray(s.runs) ? s.runs : [] };
  } catch {
    return { schedules: [], runs: [] };
  }
}

function saveSchedules(s: Saved): void {
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${fileOf()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schedules: s.schedules, runs: s.runs.slice(-RUNS_KEPT) }, null, 2) + '\n');
  renameSync(tmp, fileOf());
}

// ---- When ----

// "9", "9:30", "9am", "5:15pm", "17:00" → [hour, minute].
function clock(t: string): [number, number] | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(t.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === 'pm' ? 12 : 0);
  }
  return h <= 23 && min <= 59 ? [h, min] : null;
}

/** A schedule's "when" as a cron line (minute hour day-of-month month day-of-week), or null when it is not one binder reads. */
export function cronOf(when: string): string | null {
  const w = when.trim().toLowerCase().replace(/\s+/g, ' ');
  if (w === 'hourly') return '0 * * * *';
  let m = /^every (\d+) ?(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(w);
  if (m) {
    const n = Number(m[1]);
    if (m[2].startsWith('h')) return n >= 1 && n <= 23 ? `0 */${n} * * *` : null;
    return n >= 1 && n <= 59 ? `*/${n} * * * *` : null;
  }
  m = /^(daily|every day|weekdays|weekends|((?:sun|mon|tue|wed|thu|fri|sat)(?:,(?:sun|mon|tue|wed|thu|fri|sat))*))(?: at)? (.+)$/.exec(w);
  if (m) {
    const t = clock(m[3]);
    if (!t) return null;
    const days = m[1] === 'daily' || m[1] === 'every day' ? '*' : m[1] === 'weekdays' ? '1-5' : m[1] === 'weekends' ? '0,6' : m[1].split(',').map((d) => DAYS.indexOf(d)).join(',');
    return `${t[1]} ${t[0]} * * ${days}`;
  }
  return parseCron(w) ? w : null;
}

type Cron = { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domAll: boolean; dowAll: boolean };

function field(f: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of f.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[4] ? Number(m[4]) : 1;
    const a = m[1] === '*' ? lo : Number(m[2]);
    const b = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a;
    if (step < 1 || a < lo || b > hi || a > b) return null;
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}

function parseCron(line: string): Cron | null {
  const f = line.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const min = field(f[0], 0, 59);
  const hour = field(f[1], 0, 23);
  const dom = field(f[2], 1, 31);
  const mon = field(f[3], 1, 12);
  // Day names (mon,thu) as their numbers; 7 is Sunday too, so 1-7 is every day.
  const dow = field(f[4].replace(/[a-z]{3}/g, (d) => String(DAYS.indexOf(d))), 0, 7);
  if (dow?.delete(7)) dow.add(0);
  if (!min || !hour || !dom || !mon || !dow) return null;
  return { min, hour, dom, mon, dow, domAll: f[2] === '*', dowAll: f[4] === '*' };
}

// cron's rule: with both day fields limited, either one matching is enough.
function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAll && c.dowAll) return true;
  if (c.domAll) return dow;
  if (c.dowAll) return dom;
  return dom || dow;
}

/** The first minute after `after` that `when` names (local time), or null when it never comes (or is not readable). */
export function nextRun(when: string, after: Date): Date | null {
  const line = cronOf(when);
  const c = line ? parseCron(line) : null;
  if (!c) return null;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = after.getTime() + 400 * 86_400_000;
  while (d.getTime() < end) {
    if (!c.mon.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!c.min.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else return d;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "every day at 09:00", "weekdays at 17:30", "every 15 minutes", or the cron line. */
export function describeWhen(when: string): string {
  const line = cronOf(when);
  if (!line) return when;
  const [min, hour, dom, mon, dow] = line.split(' ');
  if (dom === '*' && mon === '*' && dow === '*') {
    if (/^\*\/\d+$/.test(min) && hour === '*') return min === '*/1' ? 'every minute' : `every ${min.slice(2)} minutes`;
    if (min === '0' && (hour === '*' || hour === '*/1')) return 'every hour';
    if (min === '0' && /^\*\/\d+$/.test(hour)) return `every ${hour.slice(2)} hours`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    const at = `${pad(Number(hour))}:${pad(Number(min))}`;
    if (dow === '*') return `every day at ${at}`;
    if (dow === '1-5') return `weekdays at ${at}`;
    if (dow === '0,6') return `weekends at ${at}`;
    if (/^[0-6](,[0-6])*$/.test(dow)) return `${dow.split(',').map((d) => DAYS[Number(d)][0].toUpperCase() + DAYS[Number(d)].slice(1)).join(', ')} at ${at}`;
  }
  return `cron ${line}`;
}

// Why text that starts like a when ("daily 25:00 ...") is not one: its time, named.
function badTime(text: string): string | undefined {
  const m = /^(?:daily|every day|weekdays|weekends|(?:sun|mon|tue|wed|thu|fri|sat)(?:,(?:sun|mon|tue|wed|thu|fri|sat))*)(?: at)? (\S+)/.exec(text.trim().toLowerCase().replace(/\s+/g, ' '));
  return m && !clock(m[1]) ? `${m[1]} is not a time (try 9:00, 17:30 or 5pm)` : undefined;
}

/**
 * "/schedule daily 9:00 Summarize yesterday's commits" → when and prompt; null
 * when it does not start with a when. Throws, naming the time, when it starts
 * like one with a time binder cannot read ("daily 25:00").
 */
export function splitWhen(text: string): { when: string; prompt: string } | null {
  const t = text.trim().replace(/\s+/g, ' ');
  const words = t.split(' ');
  // The longest leading run of words that reads as a when (cron takes five).
  for (let n = Math.min(5, words.length - 1); n >= 1; n--) {
    const when = words.slice(0, n).join(' ');
    if (cronOf(when)) return { when, prompt: words.slice(n).join(' ') };
  }
  const bad = badTime(t);
  if (bad) throw new Error(bad);
  return null;
}

// ---- Tasks ----

/** A new task, saved; throws when its when or folder will not do. */
export function addSchedule(fields: { prompt: string; cwd: string; when: string; name?: string; mode?: string }, now = Date.now()): Schedule {
  const bad = badTime(fields.when);
  if (!cronOf(fields.when)) throw new Error(`Not a schedule binder reads: ${bad ?? `${fields.when} (try "daily 9:00", "weekdays 17:30", "mon,thu 8:00", "hourly", "every 15m", or a cron line)`}`);
  if (!fields.prompt.trim()) throw new Error('A scheduled task needs a prompt');
  if (fields.mode) checkMode(fields.mode);
  if (!existsSync(fields.cwd) || !statSync(fields.cwd).isDirectory()) throw new Error(`Not a folder: ${fields.cwd}`);
  const s: Schedule = {
    id: randomUUID().slice(0, 8),
    name: fields.name?.trim() || fields.prompt.trim().replace(/\s+/g, ' ').slice(0, 48),
    prompt: fields.prompt.trim(),
    cwd: fields.cwd,
    when: fields.when.trim(),
    ...(fields.mode && { mode: fields.mode }),
    createdAt: now,
  };
  const saved = loadSchedules();
  saved.schedules.push(s);
  saveSchedules(saved);
  return s;
}

function find(saved: Saved, id: string): Schedule {
  const s = saved.schedules.find((x) => x.id === id);
  if (!s) throw new Error(`No scheduled task ${id}`);
  return s;
}

export function removeSchedule(id: string): Schedule {
  const saved = loadSchedules();
  const s = find(saved, id);
  saved.schedules = saved.schedules.filter((x) => x.id !== id);
  saveSchedules(saved);
  return s;
}

export function pauseSchedule(id: string, paused: boolean): Schedule {
  const saved = loadSchedules();
  const s = find(saved, id);
  if (paused) s.paused = true;
  else {
    delete s.paused;
    // Resumed: from now on, not every time it missed.
    s.lastRunAt = Date.now();
  }
  saveSchedules(saved);
  return s;
}

/** A task's next run (null while paused), counted from its last run (or when it was made). */
export function nextFor(s: Schedule, now = Date.now()): Date | null {
  if (s.paused) return null;
  const next = nextRun(s.when, new Date(s.lastRunAt ?? s.createdAt));
  // One it missed (the Mac asleep, no app open) runs at the next tick, once.
  return next && next.getTime() < now ? new Date(now) : next;
}

/** Runs a task now: a fresh session in its folder, in its mode, named for it, sent its prompt. */
export async function runSchedule(s: Schedule, manual = false, start = startHost, ask = hostRequest): Promise<ScheduleRun> {
  const run: ScheduleRun = { scheduleId: s.id, name: s.name, at: Date.now(), ...(manual && { manual: true }) };
  const sessionId = randomUUID();
  try {
    await start({ cwd: s.cwd, sessionId, resume: false, passthrough: [] });
    run.sessionId = sessionId;
    const mode = s.mode ?? binderConfig().permissionMode;
    if (mode) await ask(sessionId, 'set_permission_mode', { mode }).catch(() => {});
    await ask(sessionId, 'send', { text: s.prompt });
    await ask(sessionId, 'rename', { title: s.name }).catch(() => {});
  } catch (e) {
    run.error = (e as Error).message;
  }
  return run;
}

function record(run: ScheduleRun): void {
  const saved = loadSchedules();
  saved.runs.push(run);
  saveSchedules(saved);
}

/** /schedule's "run now". */
export async function runNow(id: string): Promise<ScheduleRun> {
  const run = await runSchedule(find(loadSchedules(), id), true);
  record(run);
  return run;
}

// Only one ticker at a time; one that died leaves a lock that goes stale.
function lock(): (() => void) | null {
  const path = join(stateDir(), 'schedules.lock');
  mkdirSync(stateDir(), { recursive: true });
  try {
    if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
  } catch {
    // no lock
  }
  try {
    closeSync(openSync(path, 'wx'));
  } catch {
    return null;
  }
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // gone
    }
  };
}

/** Starts the tasks that are due (config.json schedules false: none), and records their runs. */
export async function tick(now = Date.now(), run = runSchedule): Promise<ScheduleRun[]> {
  if (binderConfig().schedules === false) return [];
  const release = lock();
  if (!release) return [];
  try {
    const saved = loadSchedules();
    const due = saved.schedules.filter((s) => {
      const next = nextFor(s, now);
      return next !== null && next.getTime() <= now;
    });
    if (!due.length) return [];
    // Marked first: a ticker that dies mid-run must not start them again.
    for (const s of due) s.lastRunAt = now;
    saveSchedules(saved);
    const runs: ScheduleRun[] = [];
    for (const s of due) {
      const r = await run(s);
      record(r);
      runs.push(r);
    }
    return runs;
  } finally {
    release();
  }
}
