// Writes fixtures/wire-patches.json: snapshots and the patches between them for
// two recorded streams, so a client in another language can check that applying
// the patches reproduces the final snapshot (the iOS app's tests use it).
//   npx tsx test/manual/makeWireFixture.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, reduce, type State } from '../../src/store.js';
import { parseEventLine, type ClaudeEvent } from '../../src/events.js';
import { diff, wireState, type Source } from '../../src/remote/wire.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');

function record(fixture: string, batch: number) {
  const events = readFileSync(join(FIXTURES, fixture), 'utf8').split('\n').map(parseEventLine).filter((e): e is ClaudeEvent => e !== null);
  let state: State = initialState('fixture-session');
  let src: Source = { state, cwd: '/work', effort: 'high' };
  const start = JSON.parse(JSON.stringify(wireState(src)));
  const patches: unknown[] = [];
  const step = (next: State) => {
    const nextSrc = { ...src, state: next };
    const p = diff(src, nextSrc);
    if (p) patches.push(JSON.parse(JSON.stringify(p)));
    src = nextSrc;
    state = next;
  };
  let turn = 0;
  const send = () => {
    turn++;
    let s = reduce(state, { type: 'submit', prompt: `prompt ${turn}`, tabId: turn });
    s = reduce(s, { type: 'sent', tabId: turn, uuid: `uuid-${turn}` });
    step(s);
  };
  send();
  for (let i = 0; i < events.length; i += batch) {
    const chunk = events.slice(i, i + batch);
    step(reduce(state, { type: 'events', events: chunk }));
    if (chunk.some((e) => e.type === 'result') && i + batch < events.length) send();
  }
  return { name: fixture, start, patches, end: JSON.parse(JSON.stringify(wireState(src))) };
}

writeFileSync(join(FIXTURES, 'wire-patches.json'), JSON.stringify({ cases: [record('long-turn.jsonl', 9), record('two-turns-stdin.jsonl', 1)] }) + '\n');
console.log('wrote fixtures/wire-patches.json');
