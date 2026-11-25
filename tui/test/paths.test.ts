import { describe, it, expect } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, stateDir, STATE_FILE_MODE } from '../src/paths.js';
import { readConfig, saveConfig } from '../src/config.js';
import { FIXTURES } from './helpers.js';

describe('state dir is private to the user', () => {
  it('creates the state dir 0700 and self-heals a dir left 0755 by an older binder', () => {
    const dir = join(mkdtempSync('/tmp/binder-state-'), 'bindertui');
    const prev = process.env.BINDER_STATE_DIR;
    process.env.BINDER_STATE_DIR = dir;
    try {
      expect(statSync(stateDir()).mode & 0o777).toBe(0o700);
      chmodSync(dir, 0o755); // as an older binder would have left it
      expect(statSync(stateDir()).mode & 0o777).toBe(0o700); // self-healed
    } finally {
      if (prev === undefined) delete process.env.BINDER_STATE_DIR;
      else process.env.BINDER_STATE_DIR = prev;
    }
  });

  it('writes state files readable only by the user', () => {
    const dir = mkdtempSync('/tmp/binder-state-');
    const f = join(dir, 'x.jsonl');
    writeFileSync(f, 'secret transcript\n', { mode: STATE_FILE_MODE });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe('account routing', () => {
  const config = { configDirs: { '~/work': '~/.claude-alt' } };
  it('inherits CLAUDE_CONFIG_DIR untouched when set', () => {
    const env = { CLAUDE_CONFIG_DIR: '/custom' };
    expect(childEnv(join(homedir(), 'work', 'repo'), env, config).CLAUDE_CONFIG_DIR).toBe('/custom');
  });
  it('turns on file checkpointing for /rewind unless the user set it', () => {
    expect(childEnv('/tmp', {}).CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('true');
    expect(childEnv('/tmp', { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '' }).CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('');
  });
  it('turns on artifacts unless config.json or the user says otherwise', () => {
    expect(childEnv('/tmp', {}, {}).CLAUDE_CODE_ARTIFACT).toBe('1');
    expect(childEnv('/tmp', {}, { artifacts: true }).CLAUDE_CODE_ARTIFACT).toBe('1');
    expect(childEnv('/tmp', {}, { artifacts: false }).CLAUDE_CODE_ARTIFACT).toBeUndefined();
    expect(childEnv('/tmp', { CLAUDE_CODE_ARTIFACT: '0' }, {}).CLAUDE_CODE_ARTIFACT).toBe('0');
    expect(childEnv(join(homedir(), 'work'), {}, { ...config, artifacts: false }).CLAUDE_CODE_ARTIFACT).toBeUndefined();
  });
  it('picks the config dir from configDirs when CLAUDE_CONFIG_DIR is unset', () => {
    expect(childEnv(join(homedir(), 'work', 'repo'), {}, config).CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude-alt'));
    expect(childEnv(join(homedir(), 'work'), {}, config).CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude-alt'));
    expect(childEnv(join(homedir(), 'workx'), {}, config).CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(childEnv(join(homedir(), 'other'), {}, config).CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(childEnv(join(homedir(), 'work'), {}, {}).CLAUDE_CONFIG_DIR).toBeUndefined();
  });
  it("drops the NODE_ENV binder set for itself but keeps the user's own", () => {
    const ours = childEnv('/tmp', { NODE_ENV: 'production', BINDER_SET_NODE_ENV: '1', PATH: '/bin' });
    expect(ours.NODE_ENV).toBeUndefined();
    expect(ours.BINDER_SET_NODE_ENV).toBeUndefined();
    expect(ours.PATH).toBe('/bin');
    expect(childEnv('/tmp', { NODE_ENV: 'test' }).NODE_ENV).toBe('test');
  });
});

describe('config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'binder-config-'));
  it('is empty when the file is missing', () => {
    expect(readConfig(join(dir, 'missing.json'))).toEqual({});
  });
  it('reads the file, and names it when it is not valid JSON', () => {
    writeFileSync(join(dir, 'ok.json'), '{"permissionMode":"plan"}');
    expect(readConfig(join(dir, 'ok.json'))).toEqual({ permissionMode: 'plan' });
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(() => readConfig(join(dir, 'bad.json'))).toThrow(join(dir, 'bad.json'));
    // JSON, but not settings: named too, so binder can say so in one line.
    writeFileSync(join(dir, 'null.json'), 'null');
    expect(() => readConfig(join(dir, 'null.json'))).toThrow(`${join(dir, 'null.json')}: not a JSON object`);
  });
  it('saves keys in place: others kept, undefined removed, a symlink kept a symlink', () => {
    const target = join(dir, 'dotfiles.json');
    writeFileSync(target, JSON.stringify({ permissionMode: 'plan', stickyPrompt: true, extra: 1 }));
    const link = join(dir, 'linked.json');
    symlinkSync(target, link);
    expect(saveConfig({ permissionMode: undefined, markdownStyle: 'classic' }, link)).toEqual({ stickyPrompt: true, extra: 1, markdownStyle: 'classic' });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{\n  "stickyPrompt": true,\n  "extra": 1,\n  "markdownStyle": "classic"\n}\n');
    expect(saveConfig({ stickyPrompt: false }, join(dir, 'new', 'config.json'))).toEqual({ stickyPrompt: false });
  });
  it('leaves a file that does not parse alone', () => {
    writeFileSync(join(dir, 'broken.json'), '{');
    expect(() => saveConfig({ stickyPrompt: true }, join(dir, 'broken.json'))).toThrow(join(dir, 'broken.json'));
    expect(readFileSync(join(dir, 'broken.json'), 'utf8')).toBe('{');
  });
  it('stops binder at launch with one line naming the file and what is wrong, not a stack trace', () => {
    const bin = join(FIXTURES, '..', 'bin', 'binder.mjs');
    for (const [name, text, why] of [['bad.json', '{', "Expected property name or '}' in JSON at position 1"], ['null.json', 'null', 'not a JSON object']]) {
      const file = join(dir, `launch-${name}`);
      writeFileSync(file, text);
      const r = spawnSync(process.execPath, [bin], { cwd: dir, env: { ...process.env, BINDER_CONFIG: file }, encoding: 'utf8', timeout: 20000 });
      expect(r.status).toBe(1);
      expect(r.stderr.startsWith(`binder: ${file}: ${why}`)).toBe(true);
      expect(r.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  });
});
