#!/usr/bin/env node
// React's development build is several times slower and adds dev-only
// warnings, so binder runs the production build. BINDER_SET_NODE_ENV marks
// that the value is ours, so it is not passed on to claude and the user's
// commands.
if (process.env.NODE_ENV === undefined) {
  process.env.NODE_ENV = 'production';
  process.env.BINDER_SET_NODE_ENV = '1';
}
// The commands without a terminal UI skip loading Ink and React.
if (['host', 'serve', 'remote'].includes(process.argv[2])) {
  const { remoteMain } = await import('../dist/remote/cli.js');
  await remoteMain(process.argv.slice(2));
} else {
  const { main } = await import('../dist/cli.js');
  main();
}
