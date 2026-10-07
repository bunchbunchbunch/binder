// Manual spike against the real binary for the two control-protocol flows:
// answering AskUserQuestion and interrupting a running turn.
//   npx tsx test/manual/askAndInterrupt.ts
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { ClaudeProcess, buildArgs } from '../../src/claudeProcess.js';

const proc = new ClaudeProcess({
  bin: 'claude',
  args: buildArgs({ sessionId: randomUUID(), resume: false, passthrough: ['--model', 'haiku'] }),
  cwd: process.cwd(),
  env: process.env,
});
proc.on('raw', (l) => {
  console.log('<<', l.slice(0, 300));
  if (process.env.BINDER_RECORD) appendFileSync(process.env.BINDER_RECORD, l + '\n');
});
proc.on('exit', (e) => console.log('exit', e));
proc.start();

let phase = 0;
proc.on('event', (e) => {
  if (e.type === 'control_request') {
    const req = e as { request_id: string; request: { subtype: string; tool_name?: string; input?: Record<string, unknown> } };
    if (req.request.subtype === 'can_use_tool' && req.request.tool_name === 'AskUserQuestion') {
      const input = req.request.input as { questions: Array<{ question: string }> };
      const answers: Record<string, string> = {};
      for (const q of input.questions) answers[q.question] = 'Blue';
      proc.respondControl(req.request_id, { behavior: 'allow', updatedInput: { ...input, answers } });
    }
  }
  if (e.type === 'result') {
    console.log('RESULT', phase, (e as { result?: string }).result);
    if (phase === 0) {
      phase = 1;
      proc.sendPrompt('Count from 1 to 300, one number per line, no other text.');
      setTimeout(() => {
        console.log('>> interrupt');
        proc.interrupt();
      }, 4000);
    } else {
      void proc.close();
    }
  }
});
proc.sendPrompt('Use the AskUserQuestion tool to ask me which color I prefer, red or blue. Then tell me what I picked.');
