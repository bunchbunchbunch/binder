import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90000,
  workers: 1,
  reporter: 'list',
});
