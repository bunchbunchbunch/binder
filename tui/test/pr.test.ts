import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixPrompt, parsePr, prLine, prTone } from '../src/pr.js';
import { FIXTURES } from './helpers.js';

const json = readFileSync(join(FIXTURES, 'gh-pr.json'), 'utf8');

describe('the pull request', () => {
  it("reads gh's checks: failing, passing (check runs and statuses), and still running; skipped ones are not counted", () => {
    const pr = parsePr(json);
    expect(pr).toMatchObject({ number: 12, state: 'OPEN', head: 'abc123', review: 'REVIEW_REQUIRED' });
    expect(pr.checks).toEqual({ passing: 2, failing: ['lint', 'test'], pending: 1 });
    expect(prLine(pr)).toBe('PR #12 · ✗ 2 failing (lint, test)');
  });

  it('asks Claude to fix failing checks, else to address a review asking for changes; once per commit and failure', () => {
    const pr = parsePr(json);
    expect(fixPrompt(pr)).toEqual({ key: 'checks:abc123:lint,test', text: expect.stringMatching(/^\[binder\] CI checks failed on PR #12 \(lint, test\)/) });
    const green = parsePr(JSON.stringify({ ...JSON.parse(json), statusCheckRollup: [], reviewDecision: 'CHANGES_REQUESTED', latestReviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-11-24T10:00:00Z', author: { login: 'ana' } }] }));
    expect(prLine(green)).toBe('PR #12 · no checks · changes requested');
    expect(fixPrompt(green)).toEqual({ key: 'review:2026-11-24T10:00:00Z', text: expect.stringMatching(/^\[binder\] ana asked for changes on PR #12/) });
    expect(fixPrompt({ ...green, state: 'MERGED' })).toBeNull();
    expect(prLine({ ...green, state: 'MERGED' })).toBe('PR #12 · merged · changes requested');
  });

  it('colors the row: red for failing checks or changes requested, gold while running, green when passing, neutral with nothing to go by', () => {
    const pr = parsePr(json);
    const checks = (c: Partial<typeof pr.checks>) => ({ ...pr, review: '', checks: { passing: 0, failing: [], pending: 0, ...c } });
    expect(prTone(pr)).toBe('failing');
    expect(prTone({ ...checks({ passing: 3 }), review: 'CHANGES_REQUESTED' })).toBe('failing');
    expect(prTone(checks({ passing: 3, pending: 1 }))).toBe('pending');
    expect(prTone(checks({ passing: 3 }))).toBe('passing');
    // Skipped and neutral checks are not counted, so only those is the same as none.
    expect(prTone(parsePr(JSON.stringify({ ...JSON.parse(json), statusCheckRollup: [{ name: 'deploy', status: 'COMPLETED', conclusion: 'SKIPPED' }], reviewDecision: '' })))).toBe('neutral');
    expect(prTone(checks({}))).toBe('neutral');
  });
});
