import { describe, it, expect } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../src/paths.js';
import { readConfig, saveConfig } from '../src/config.js';

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
});
