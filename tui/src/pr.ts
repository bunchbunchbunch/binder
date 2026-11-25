import { execFile } from 'node:child_process';

// The session's pull request, through the GitHub CLI (`gh`, or BINDER_GH): its
// checks and reviews, for the status row, /pr, and auto-fix (config.json
// prAutoFix). A folder with no PR for its branch, or no gh, has none.

export type PrChecks = { passing: number; failing: string[]; pending: number };
export type PrStatus = {
  number: number;
  title: string;
  url: string;
  state: string; // OPEN, MERGED, CLOSED
  draft: boolean;
  head: string; // the head commit
  mergeable: string; // MERGEABLE, CONFLICTING, UNKNOWN
  review: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or ''
  checks: PrChecks;
  // The latest review asking for changes (when, and by whom), to address once.
  changesRequested?: { at: string; by: string };
};

const FIELDS = 'number,title,url,state,isDraft,headRefOid,mergeable,reviewDecision,statusCheckRollup,latestReviews';

const gh = (cwd: string, args: string[]): Promise<string> =>
  new Promise((done, fail) => {
    execFile(process.env.BINDER_GH ?? 'gh', args, { cwd, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => (err ? fail(new Error(String(errOut || err.message).trim())) : done(out)));
  });

const FAIL = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
// Skipped and neutral checks neither pass nor block, so they are not counted.
const QUIET = ['NEUTRAL', 'SKIPPED'];

export function checksOf(rollup: unknown): PrChecks {
  const out: PrChecks = { passing: 0, failing: [], pending: 0 };
  for (const c of Array.isArray(rollup) ? (rollup as Array<Record<string, unknown>>) : []) {
    // A check run has a status and a conclusion; a commit status, a state.
    const verdict = String(c.conclusion || c.state || '').toUpperCase();
    const name = String(c.name ?? c.context ?? 'check');
    const done = c.status === undefined || c.status === 'COMPLETED';
    if (FAIL.includes(verdict)) out.failing.push(name);
    else if (QUIET.includes(verdict) && done) continue;
    else if (verdict === 'SUCCESS' && done) out.passing++;
    else out.pending++;
  }
  return out;
}

export function parsePr(json: string): PrStatus {
  const p = JSON.parse(json) as Record<string, unknown>;
  const reviews = Array.isArray(p.latestReviews) ? (p.latestReviews as Array<{ state?: string; submittedAt?: string; author?: { login?: string } }>) : [];
  const asked = reviews.filter((r) => r.state === 'CHANGES_REQUESTED').sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)))[0];
  return {
    number: Number(p.number),
    title: String(p.title ?? ''),
    url: String(p.url ?? ''),
    state: String(p.state ?? ''),
    draft: p.isDraft === true,
    head: String(p.headRefOid ?? ''),
    mergeable: String(p.mergeable ?? ''),
    review: String(p.reviewDecision ?? ''),
    checks: checksOf(p.statusCheckRollup),
    ...(asked && { changesRequested: { at: String(asked.submittedAt ?? ''), by: String(asked.author?.login ?? 'a reviewer') } }),
  };
}

/** The PR for `cwd`'s branch, or null when there is none (or no gh, or no GitHub remote). */
export async function fetchPr(cwd: string): Promise<PrStatus | null> {
  try {
    return parsePr(await gh(cwd, ['pr', 'view', '--json', FIELDS]));
  } catch {
    return null;
  }
}

/** Merge when ready: GitHub merges it (squash) once its checks and reviews allow. */
export async function mergeWhenReady(cwd: string, pr: number): Promise<string> {
  await gh(cwd, ['pr', 'merge', String(pr), '--auto', '--squash']);
  return `PR #${pr} merges (squash) once its checks pass and it is approved`;
}

/** "✓ 5 passing", "✗ 2 failing (lint, test)", "◐ 3 running", with the review. */
export function prLine(pr: PrStatus): string {
  const c = pr.checks;
  const checks = c.failing.length ? `✗ ${c.failing.length} failing (${c.failing.slice(0, 3).join(', ')}${c.failing.length > 3 ? ', …' : ''})` : c.pending ? `◐ ${c.pending} running` : c.passing ? `✓ ${c.passing} passing` : 'no checks';
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.draft ? 'draft' : '';
  const review = pr.review === 'APPROVED' ? 'approved' : pr.review === 'CHANGES_REQUESTED' ? 'changes requested' : '';
  return [`PR #${pr.number}`, state, state === 'merged' || state === 'closed' ? '' : checks, review].filter(Boolean).join(' · ');
}

/** The PR row's color: failing checks or a review asking for changes, checks still running, checks passing, or nothing to go by (no checks, or only skipped ones). */
export function prTone(pr: PrStatus): 'failing' | 'pending' | 'passing' | 'neutral' {
  const c = pr.checks;
  if (c.failing.length || pr.review === 'CHANGES_REQUESTED') return 'failing';
  if (c.pending) return 'pending';
  return c.passing ? 'passing' : 'neutral';
}

// What auto-fix asks Claude, and what makes each ask one of a kind (so it is asked once).
export function fixPrompt(pr: PrStatus): { key: string; text: string } | null {
  if (pr.state !== 'OPEN') return null;
  if (pr.checks.failing.length) {
    return {
      key: `checks:${pr.head}:${pr.checks.failing.join(',')}`,
      text: `[binder] CI checks failed on PR #${pr.number} (${pr.checks.failing.join(', ')}). Read the failures (gh pr checks ${pr.number}, then gh run view --log-failed) and fix them, then push.`,
    };
  }
  if (pr.changesRequested) {
    return {
      key: `review:${pr.changesRequested.at}`,
      text: `[binder] ${pr.changesRequested.by} asked for changes on PR #${pr.number}. Read the review (gh pr view ${pr.number} --comments) and address each comment, then push.`,
    };
  }
  return null;
}
