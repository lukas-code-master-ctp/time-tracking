/**
 * Browser pieces shared by the e2e scripts: Chromium with the dev extension
 * loaded, messages to its service worker, and the portal's Vite dev server.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { chromiumPath } from './chromium.ts';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const EXTENSION_DEV_DIR = join(ROOT, 'extension', 'dist-dev');
export const PORTAL_DIR = join(ROOT, 'portal');

export interface ExtensionBrowser {
  ctx: BrowserContext;
  sw: Worker;
  extId: string;
  close(): Promise<void>;
}

/** Persistent Chromium profile with `extension/dist-dev` loaded (headless). */
export async function launchExtension(extDir: string = EXTENSION_DEV_DIR): Promise<ExtensionBrowser> {
  const profile = mkdtempSync(join(tmpdir(), 'tt-ext-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromiumPath(),
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    const sw =
      ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ??
      (await ctx.waitForEvent('serviceworker', { timeout: 15_000 }));
    return {
      ctx,
      sw,
      extId: new URL(sw.url()).host,
      async close() {
        await ctx.close();
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      },
    };
  } catch (err) {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    throw err;
  }
}

export interface SwReply {
  ok: boolean;
  error?: string;
  debug?: unknown;
  status?: unknown;
}

/** Sends a popup/debug message to the extension's service worker from one of its pages. */
export function sendFrom(page: Page, msg: Record<string, unknown>): Promise<SwReply> {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), msg) as Promise<SwReply>;
}

/** The portal's Vite dev server (development mode → emulators + dev login). */
export async function startPortal(port: number): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: join(PORTAL_DIR, 'vite.config.ts'),
    root: PORTAL_DIR,
    mode: 'development',
    logLevel: 'warn',
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await server.listen();
  return server;
}
