import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Runs the built app (out/) against bindertui's real `binder host` with its
// fake claude replaying a fixture. Every launch gets its own state, config
// and settings folders, so nothing touches the user's sessions.

export const ROOT = resolve(__dirname, '..');
export const BINDERTUI = process.env.BINDERTUI ?? resolve(ROOT, '../tui');
export const SHOWCASE = join(ROOT, 'e2e/fixtures/showcase.jsonl');
export const tuiFixture = (name: string) => join(BINDERTUI, 'fixtures', name);
export const shot = (name: string) => join(ROOT, 'e2e/screenshots', `${name}.png`);

export type Launched = {
  app: ElectronApplication;
  page: Page;
  tmp: string;
  project: string;
  // Ends the app at once (no quit warning); its hosts keep running.
  quitApp: () => Promise<void>;
  // Ends the app and the hosts it started.
  close: () => Promise<void>;
};

export const PACKAGED = join(ROOT, 'release/mac-arm64/Binder.app/Contents/MacOS/Binder');

type LaunchOptions = {
  // An earlier launch's folder: relaunch on the same state (its hosts may still run).
  reuse?: string;
  // Run release/'s Binder.app with launchd's bare environment, as the Dock starts it.
  packaged?: boolean;
};

export async function launch(fixture: string, env: Record<string, string> = {}, { reuse, packaged }: LaunchOptions = {}): Promise<Launched> {
  // Short: unix socket paths must stay under 104 bytes.
  const tmp = reuse ?? mkdtempSync('/tmp/bg-');
  const project = join(tmp, 'app');
  if (!reuse) mkdirSync(project);
  const stateDir = join(tmp, 's');
  const base: NodeJS.ProcessEnv = packaged ? { HOME: process.env.HOME!, USER: process.env.USER!, SHELL: process.env.SHELL!, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: process.env.TMPDIR! } : { ...process.env, BINDER_BIN: join(BINDERTUI, 'bin/binder.mjs') };
  const app = await electron.launch({
    ...(packaged ? { executablePath: PACKAGED, args: [] } : { args: [join(ROOT, 'out/main/index.js')] }),
    env: {
      ...base,
      BINDER_STATE_DIR: stateDir,
      BINDER_CLAUDE_BIN: join(BINDERTUI, 'test/fakeClaude.mjs'),
      BINDER_FAKE_FIXTURE: fixture,
      BINDER_FAKE_DELAY_MS: '8',
      BINDER_CONFIG: '/nonexistent/binder-config.json',
      BINDER_HOST_IDLE_MS: '3000',
      CLAUDE_CONFIG_DIR: join(tmp, 'claude'),
      BINDER_GUI_USER_DATA: join(tmp, 'gui'),
      BINDER_GUI_BACKGROUND: '1',
      ...env,
    },
  });
  const page = await app.firstWindow();
  await page.locator('.sidebar').waitFor();
  const quitApp = async () => {
    await app.evaluate(({ app }) => void setTimeout(() => app.exit(0), 10)).catch(() => {});
    await app.close().catch(() => {});
  };
  const close = async () => {
    await quitApp();
    // Hosts the app started: stop them rather than wait for their idle exit.
    const sock = join(stateDir, 'sock');
    if (!existsSync(sock)) return;
    for (const f of readdirSync(sock).filter((n) => n.endsWith('.pid'))) {
      try {
        process.kill(Number(readFileSync(join(sock, f), 'utf8')), 'SIGTERM');
      } catch {
        // gone already
      }
    }
  };
  return { app, page, tmp, project, quitApp, close };
}

/** ⌘N, then start a session in `dir`; resolves once the prompt is ready. */
export async function newSession(page: Page, dir: string): Promise<void> {
  await page.keyboard.press('Meta+n');
  await page.locator('.picker-search').fill(dir);
  await page.locator('.picker-item', { hasText: `Start in ${dir}` }).waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.session:not([hidden]) .composer textarea').waitFor({ state: 'visible', timeout: 30000 });
}
