// A pane's program for the e2e tests, standing in for a todo TUI: it shows
// what it was started with, and on c asks the app to open a session through
// BINDER_GUI_SOCKET, as such a program would. q exits.
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

const say = (text) => process.stdout.write(text + '\r\n');
say(`pane ready ${process.stdout.columns}x${process.stdout.rows} in ${process.env.TERM_PROGRAM} with socket ${process.env.BINDER_GUI_SOCKET ? 'set' : 'unset'}`);
process.stdout.on('resize', () => say(`resized ${process.stdout.columns}x${process.stdout.rows}`));
process.stdin.setRawMode(true);
process.stdin.on('data', (b) => {
  const key = b.toString();
  if (key === 'q') process.exit(3);
  if (key !== 'c') return say(`key ${JSON.stringify(key)}`);
  const sessionId = randomUUID();
  const s = connect(process.env.BINDER_GUI_SOCKET);
  s.on('data', (d) => say(`opened ${sessionId} ${d.toString().trim()}`));
  s.write(JSON.stringify({ t: 'open', cwd: process.cwd(), sessionId, draft: 'Write the report', args: ['-n', 'Write the report'] }) + '\n');
});
