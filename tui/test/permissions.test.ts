import { describe, it, expect } from 'vitest';
import { alwaysChoices, checkMode, planChoices } from '../src/permissions.js';
import { initialState, reduce } from '../src/store.js';
import type { ClaudeEvent } from '../src/events.js';

// Suggestions as Claude Code 2.1.331 sent them (probed live).
const RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir -p alpha && echo made' }], behavior: 'allow', destination: 'localSettings' };
const DIRS = { type: 'addDirectories', directories: ['/private/tmp/demo'], destination: 'session' };
const MODE = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };

describe('always allow choices', () => {
  it('keeps the rules apart from the mode switch, each with the directories', () => {
    const choices = alwaysChoices([RULE, DIRS, MODE]);
    expect(choices.map((c) => c.label)).toEqual(['Always allow Bash(mkdir -p alpha && echo made)', 'Allow, and accept all edits from now on']);
    expect(choices[0].description).toBe('this project, in .claude/settings.local.json');
    expect(choices[0].updates).toEqual([RULE, DIRS]);
    expect(choices[1].updates).toEqual([MODE, DIRS]);
  });

  it('names one of a /etc and /private/etc pair, and sends both', () => {
    const read = (path: string) => ({ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: path }], behavior: 'allow', destination: 'session' });
    const choices = alwaysChoices([read('//etc/**'), read('//private/etc/**')]);
    expect(choices).toHaveLength(1);
    expect(choices[0].label).toBe('Always allow Read(//etc/**)');
    expect(choices[0].description).toBe('this session only');
    expect(choices[0].updates).toHaveLength(2);
  });

  it('offers directories alone, cuts long labels, and skips what it cannot read', () => {
    expect(alwaysChoices([DIRS]).map((c) => c.label)).toEqual(['Always allow access to /private/tmp/demo']);
    const long = { ...RULE, rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(200) }] };
    expect(alwaysChoices([long])[0].label).toHaveLength(90);
    expect(alwaysChoices(undefined)).toEqual([]);
    expect(alwaysChoices([{ type: 'addRules', rules: 'nope' }, { type: 'setMode', mode: 'warp', destination: 'session' }, null, 5])).toEqual([]);
    // A deny rule is not an "always allow".
    expect(alwaysChoices([{ ...RULE, behavior: 'deny' }])).toEqual([]);
  });
});

describe('fast mode in the store', () => {
  const event = (e: Record<string, unknown>) => ({ type: 'event', event: e as unknown as ClaudeEvent }) as const;
  it('follows init, result and the fast_mode action, and ignores events without it', () => {
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'go', tabId: 1 });
    s = reduce(s, { type: 'sent', tabId: 1 });
    s = reduce(s, event({ type: 'system', subtype: 'init', session_id: 'sid', cwd: '/tmp', model: 'claude-opus-5-5', permissionMode: 'default', fast_mode_state: 'on' }));
    expect(s.fastMode).toBe('on');
    s = reduce(s, event({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, session_id: 'sid', fast_mode_state: 'cooldown' }));
    expect(s.fastMode).toBe('cooldown');
    s = reduce(s, event({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, session_id: 'sid' }));
    expect(s.fastMode).toBe('cooldown');
    s = reduce(s, { type: 'fast_mode', state: 'off' });
    expect(s.fastMode).toBe('off');
    // A new session keeps it until its child reports its own.
    expect(reduce(s, { type: 'reset', state: initialState('other') }).fastMode).toBe('off');
  });
});

describe('plan choices', () => {
  it('approve into auto, accept edits or manual; bypass first when plan mode came from it', () => {
    expect(planChoices().map((c) => c.label)).toEqual(['Yes, and use auto mode', 'Yes, and auto-accept edits', 'Yes, and manually approve edits']);
    const back = planChoices('bypassPermissions');
    expect(back[0].label).toBe('Yes, and bypass permissions');
    expect(back[0].updates).toEqual([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }]);
    expect(planChoices('acceptEdits')).toHaveLength(3);
  });

  it('knows the permission mode names', () => {
    for (const mode of ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) expect(() => checkMode(mode)).not.toThrow();
    for (const mode of ['bogus', 'toString', '']) expect(() => checkMode(mode)).toThrow(`Not a permission mode: ${mode} (one of default, acceptEdits, plan, auto, dontAsk, bypassPermissions)`);
  });
});
