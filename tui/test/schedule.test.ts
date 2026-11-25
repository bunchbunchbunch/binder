import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addSchedule, cronOf, describeWhen, loadSchedules, nextFor, nextRun, pauseSchedule, removeSchedule, runSchedule, splitWhen, tick, type Schedule } from '../src/schedule.js';
import { hostInfo } from '../src/remote/serve.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';

// Tuesday 24 November 2026, local time.
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);
const fmt = (d: Date | null) => (d ? `${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]}` : null);

describe('when a scheduled task runs', () => {
  it('reads friendly forms and cron lines', () => {
    expect(cronOf('daily 9:00')).toBe('0 9 * * *');
    expect(cronOf('every day at 5:30pm')).toBe('30 17 * * *');
    expect(cronOf('weekdays 17:30')).toBe('30 17 * * 1-5');
    expect(cronOf('weekends 10am')).toBe('0 10 * * 0,6');
    expect(cronOf('mon,thu 8:00')).toBe('0 8 * * 1,4');
    expect(cronOf('hourly')).toBe('0 * * * *');
    expect(cronOf('every 15m')).toBe('*/15 * * * *');
    expect(cronOf('every 2 hours')).toBe('0 */2 * * *');
    expect(cronOf('30 6 1 * *')).toBe('30 6 1 * *');
    for (const bad of ['daily 25:00', 'every 0m', 'every 90 minutes', 'sometimes', '* * *', '61 * * * *', 'daily 13pm']) expect(cronOf(bad), bad).toBeNull();
    expect(describeWhen('weekdays 17:30')).toBe('weekdays at 17:30');
    expect(describeWhen('mon,thu 8:00')).toBe('Mon, Thu at 08:00');
    expect(describeWhen('every 15m')).toBe('every 15 minutes');
    expect(describeWhen('hourly')).toBe('every hour');
    expect(describeWhen('every 1m')).toBe('every minute');
    expect(describeWhen('every 1h')).toBe('every hour');
    expect(describeWhen('30 6 1 * *')).toBe('cron 30 6 1 * *');
  });

  it('finds the next minute it names, in local time', () => {
    expect(fmt(nextRun('daily 9:00', at(24, 8, 59)))).toBe('24 09:00 Tue');
    expect(fmt(nextRun('daily 9:00', at(24, 9, 0)))).toBe('25 09:00 Wed');
    // Friday evening: weekdays skip to Monday.
    expect(fmt(nextRun('weekdays 9:00', at(27, 18)))).toBe('30 09:00 Mon');
    expect(fmt(nextRun('every 15m', at(24, 10, 7)))).toBe('24 10:15 Tue');
    expect(fmt(nextRun('every 2h', at(24, 23, 30)))).toBe('25 00:00 Wed');
    // The first of the month, or a Saturday: either day field will do, as in cron.
    expect(fmt(nextRun('0 6 1 * 6', at(24, 7)))).toBe('28 06:00 Sat');
    expect(fmt(nextRun('0 6 1 * *', at(24, 7)))).toBe('1 06:00 Tue');
    expect(nextRun('0 0 31 2 *', at(24, 7))).toBeNull();
    // Day of week as cron writes it: 7 is Sunday too, 1-7 every day, and day names.
    expect(fmt(nextRun('0 6 * * 7', at(24, 7)))).toBe('29 06:00 Sun');
    expect(fmt(nextRun('0 6 * * 1-7', at(24, 7)))).toBe('25 06:00 Wed');
    expect(fmt(nextRun('0 6 * * mon,thu', at(24, 7)))).toBe('26 06:00 Thu');
    expect(fmt(nextRun('0 6 * * MON-FRI', at(27, 7)))).toBe('30 06:00 Mon');
    expect(cronOf('0 6 * * 8')).toBeNull();
    expect(cronOf('0 6 * * fun')).toBeNull();
  });

  it('splits "/schedule <when> <prompt>"', () => {
    expect(splitWhen('daily 9:00 Summarize yesterday')).toEqual({ when: 'daily 9:00', prompt: 'Summarize yesterday' });
    expect(splitWhen('every day at 5:30pm  check the build')).toEqual({ when: 'every day at 5:30pm', prompt: 'check the build' });
    expect(splitWhen('*/30 9-17 * * 1-5 ping the queue')).toEqual({ when: '*/30 9-17 * * 1-5', prompt: 'ping the queue' });
    expect(splitWhen('hourly tidy up')).toEqual({ when: 'hourly', prompt: 'tidy up' });
    expect(splitWhen('Summarize yesterday')).toBeNull();
    // It starts like a when: the time it could not read is named.
    expect(() => splitWhen('daily 25:00 Summarize yesterday')).toThrow('25:00 is not a time (try 9:00, 17:30 or 5pm)');
    expect(() => splitWhen('mon,thu at noon check in')).toThrow('noon is not a time');
  });
});

describe('scheduled tasks', () => {
  let dir: string;
  beforeEach(() => {
    // Short: a host's unix socket path must stay under 104 bytes.
    dir = realpathSync(mkdtempSync('/tmp/bsch-'));
    process.env.BINDER_STATE_DIR = join(dir, 'state');
  });

  it('are added, paused, resumed and removed; a bad when or folder is refused', () => {
    const s = addSchedule({ prompt: 'Summarize  the day ', cwd: dir, when: 'daily 18:00' }, at(24, 12).getTime());
    expect(s).toMatchObject({ name: 'Summarize the day', prompt: 'Summarize  the day', cwd: dir, when: 'daily 18:00' });
    expect(fmt(nextFor(s, at(24, 12).getTime()))).toBe('24 18:00 Tue');
    expect(() => addSchedule({ prompt: 'x', cwd: dir, when: 'often' })).toThrow('Not a schedule binder reads: often');
    expect(() => addSchedule({ prompt: 'x', cwd: join(dir, 'nope'), when: 'hourly' })).toThrow('Not a folder');
    expect(() => addSchedule({ prompt: 'x', cwd: dir, when: 'daily 25:00' })).toThrow('Not a schedule binder reads: 25:00 is not a time');
    expect(() => addSchedule({ prompt: 'x', cwd: dir, when: 'hourly', mode: 'bogus' })).toThrow('Not a permission mode: bogus (one of default, acceptEdits, plan, auto, dontAsk, bypassPermissions)');
    expect(loadSchedules().schedules).toHaveLength(1);
    expect(pauseSchedule(s.id, true).paused).toBe(true);
    expect(nextFor(loadSchedules().schedules[0])).toBeNull();
    expect(pauseSchedule(s.id, false).paused).toBeUndefined();
    removeSchedule(s.id);
    expect(loadSchedules().schedules).toEqual([]);
    expect(() => removeSchedule(s.id)).toThrow(`No scheduled task ${s.id}`);
  });

  it('tick runs what is due once, records the run, and a missed one runs at the next tick', async () => {
    const s = addSchedule({ prompt: 'p', cwd: dir, when: 'daily 9:00', name: 'Morning' }, at(24, 8).getTime());
    const ran: string[] = [];
    const fake = async (x: Schedule) => (ran.push(x.id), { scheduleId: x.id, name: x.name, at: Date.now(), sessionId: 'sess-1' });
    expect(await tick(at(24, 8, 59).getTime(), fake)).toEqual([]);
    expect(await tick(at(24, 9, 0).getTime(), fake)).toHaveLength(1);
    expect(await tick(at(24, 9, 1).getTime(), fake)).toEqual([]);
    expect(loadSchedules().schedules[0].lastRunAt).toBe(at(24, 9).getTime());
    // Asleep through Wednesday's run: once, at Thursday's first tick.
    expect(await tick(at(26, 7, 30).getTime(), fake)).toHaveLength(1);
    expect(await tick(at(26, 7, 31).getTime(), fake)).toEqual([]);
    expect(ran).toEqual([s.id, s.id]);
    expect(loadSchedules().runs.map((r) => r.sessionId)).toEqual(['sess-1', 'sess-1']);
    // Another ticker holds the lock: this one does nothing.
    writeFileSync(join(dir, 'state', 'schedules.lock'), '');
    expect(await tick(at(27, 9, 0).getTime(), fake)).toEqual([]);
  });

  it('a run starts a fresh session in the folder, sends the prompt, and names it for the task (through binder host)', async () => {
    const input = join(dir, 'input.jsonl');
    // Over ssh, binder starts hosts through launchd; here, as on the Mac itself.
    delete process.env.SSH_CONNECTION;
    Object.assign(process.env, { BINDER_CLAUDE_BIN: FAKE_BIN, BINDER_FAKE_FIXTURE: join(FIXTURES, 'two-turns-stdin.jsonl'), BINDER_FAKE_INPUT_OUT: input, CLAUDE_CONFIG_DIR: join(dir, 'claude') });
    const s = addSchedule({ prompt: 'Say A', cwd: dir, when: 'hourly', name: 'Hourly A', mode: 'acceptEdits' });
    const run = await runSchedule(s, true);
    try {
      expect(run).toMatchObject({ scheduleId: s.id, name: 'Hourly A', manual: true });
      expect(run.error).toBeUndefined();
      const sent = () => (existsSync(input) ? readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
      await expect.poll(() => sent().filter((m) => m.type === 'user').map((m) => m.message.content), { timeout: 10000 }).toEqual(['Say A']);
      expect(sent().some((m) => m.type === 'control_request' && m.request.subtype === 'set_permission_mode' && m.request.mode === 'acceptEdits')).toBe(true);
      await expect.poll(async () => (await hostInfo(run.sessionId!))?.title, { timeout: 10000 }).toBe('Hourly A');
      expect((await hostInfo(run.sessionId!))?.cwd).toBe(dir);
    } finally {
      const info = run.sessionId ? await hostInfo(run.sessionId) : null;
      if (info) process.kill(info.pid, 'SIGTERM');
    }
  }, 30000);

  it('binder schedule: add, list (with its next run), history, remove', () => {
    const bin = join(FIXTURES, '..', 'bin', 'binder.mjs');
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [bin, 'schedule', ...args], { encoding: 'utf8', env: process.env }));
    const s = cli('add', '--when', 'weekdays 9:00', '--cwd', dir, '--name', 'Standup', '--', 'Write', 'the', 'standup');
    expect(s).toMatchObject({ name: 'Standup', prompt: 'Write the standup', when: 'weekdays 9:00', cwd: dir });
    const [row] = cli('list');
    expect(row).toMatchObject({ id: s.id, describe: 'weekdays at 09:00', lastRun: null });
    expect(typeof row.next).toBe('number');
    expect(cli('history')).toEqual([]);
    expect(cli('pause', s.id).paused).toBe(true);
    cli('remove', s.id);
    expect(cli('list')).toEqual([]);
    expect(() => execFileSync(process.execPath, [bin, 'schedule', 'add', '--when', 'often', '--', 'x'], { encoding: 'utf8', env: process.env, stdio: 'pipe' })).toThrow(/Not a schedule binder reads: often/);
  });
});
