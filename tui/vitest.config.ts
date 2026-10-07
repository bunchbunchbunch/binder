import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 20000,
    // Never the developer's own ~/.config/binder/config.json.
    env: { BINDER_CONFIG: '/nonexistent/binder-config.json' },
  },
});
