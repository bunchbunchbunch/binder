// Ink render options shared by the CLI and the rendering benchmark.
export const RENDER_OPTIONS = {
  alternateScreen: true,
  exitOnCtrlC: false,
  // Rewrite only the lines that changed between frames instead of the whole
  // screen: a keystroke sends one line, not 45.
  incrementalRendering: process.env.BINDER_FULL_REDRAW !== '1',
  // Without the kitty keyboard protocol, terminals send Ctrl+Enter as a plain
  // Enter. 'auto' turns it on only when the terminal answers the query
  // (iTerm2, kitty, WezTerm, Ghostty); elsewhere Ctrl+Enter acts as Enter.
  kittyKeyboard: { mode: 'auto' as const },
};
