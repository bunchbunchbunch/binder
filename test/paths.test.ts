import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../src/paths.js';
import { readConfig } from '../src/config.js';

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
});
