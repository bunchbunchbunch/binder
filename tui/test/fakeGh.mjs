#!/usr/bin/env node
// Stand-in for the GitHub CLI (BINDER_GH) in tests:
//   gh pr view --json ...   prints BINDER_FAKE_GH_STATE's JSON, or fails like gh with no PR
//   gh pr merge ...         appends its arguments to BINDER_FAKE_GH_LOG
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const state = process.env.BINDER_FAKE_GH_STATE;
if (process.env.BINDER_FAKE_GH_LOG) appendFileSync(process.env.BINDER_FAKE_GH_LOG, JSON.stringify(args) + '\n');
if (args[0] === 'pr' && args[1] === 'view') {
  if (!state || !existsSync(state)) {
    process.stderr.write('no pull requests found for branch "main"\n');
    process.exit(1);
  }
  process.stdout.write(readFileSync(state, 'utf8'));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') process.exit(0);
process.stderr.write(`fake gh: ${args.join(' ')}\n`);
process.exit(1);
