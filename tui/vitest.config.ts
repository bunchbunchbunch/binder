import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 20000,
    // Never the developer's own ~/.config/binder/config.json.
    // No gh either: a test that wants one sets BINDER_GH to the fake.
    env: { BINDER_CONFIG: '/nonexistent/binder-config.json', BINDER_GH: '/nonexistent/gh' },
  },
});
