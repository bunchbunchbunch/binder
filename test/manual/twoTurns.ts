// Manual check against the real binary: two prompts through one process.
//   npx tsx test/manual/twoTurns.ts
import { randomUUID } from 'node:crypto';
import { ClaudeProcess, buildArgs } from '../../src/claudeProcess.js';

const sessionId = randomUUID();
const proc = new ClaudeProcess({
  bin: 'claude',
  args: buildArgs({ sessionId, resume: false, passthrough: ['--model', 'haiku'] }),
  cwd: process.cwd(),
  env: process.env,
});
proc.on('exit', (e) => console.log('exit', e));
proc.start();

const prompts = ['Reply with just: one', 'Reply with just the word you replied with before.'];
proc.on('event', (e) => {
  if (e.type === 'result') {
    console.log('result:', (e as { result?: string }).result);
    const next = prompts.shift();
    if (next) proc.sendPrompt(next);
    else void proc.close();
  }
});
proc.sendPrompt(prompts.shift()!);
