import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {},
  preload: {
    // The window's preload, and a web pane page's (window.binderPane).
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts'), pane: resolve('src/preload/pane.ts') } } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()],
  },
});
