/**
 * Smoke test of the built dev extension in a real Chromium (Playwright).
 *
 *   node scripts/smoke.ts          → loads dist-dev, checks the service worker
 *                                    starts (no load errors, no DOM globals)
 *                                    and answers the popup.
 *   node scripts/smoke.ts --e2e    → also: dev login against the emulators,
 *                                    start/stop a work day and check the
 *                                    Firestore documents. Run inside
 *   firebase emulators:exec --only auth,firestore,functions --project demo-timetracking "node extension/scripts/smoke.ts --e2e"
 *
 * Branded Google Chrome ignores `--load-extension` since v137, so this uses
 * Playwright's Chromium: `npx playwright install chromium`, or any cached
 * `ms-playwright/chromium-*` build, or `SMOKE_CHROMIUM=<path to chrome>`.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { ROOT } from '../build/common.ts';
import { DEV_EXTENSION_ID } from '../build/manifest.ts';

const E2E = process.argv.includes('--e2e');
const EXT_DIR = join(ROOT, 'dist-dev');
const PROJECT = 'demo-timetracking';
const FIRESTORE = 'http://127.0.0.1:8080';
const EMAIL = 'jefa@compratuparcela.cl'; // BOOTSTRAP_ADMINS in functions/.env.demo-timetracking

function fail(msg: string): never {
  console.error(`SMOKE FALLÓ: ${msg}`);
  process.exit(1);
}

function chromiumPath(): string {
  const fromEnv = process.env.SMOKE_CHROMIUM;
  if (fromEnv) return fromEnv;
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return bundled;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '', '.cache'), 'ms-playwright');
  const candidates = existsSync(cache)
    ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
    : [];
  for (const dir of candidates) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(cache, dir, exe);
      if (existsSync(p)) return p;
    }
  }
  fail('no se encontró Chromium de Playwright. Ejecuta `npx playwright install chromium` o define SMOKE_CHROMIUM.');
}

async function waitForWorker(ctx: BrowserContext): Promise<Worker> {
  const existing = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  return existing ?? ctx.waitForEvent('serviceworker', { timeout: 15_000 });
}

async function firestoreDocs(collection: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${collection}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  if (!res.ok) fail(`Firestore ${collection}: HTTP ${res.status}`);
  const body = (await res.json()) as { documents?: { name: string; fields: Record<string, unknown> }[] };
  return (body.documents ?? []).map((d) => ({ id: d.name.split('/').pop(), ...d.fields }));
}

async function main(): Promise<void> {
  if (!existsSync(join(EXT_DIR, 'manifest.json'))) fail(`no existe ${EXT_DIR}; ejecuta npm run build:dev -w extension`);
  const profile = mkdtempSync(join(tmpdir(), 'tt-smoke-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromiumPath(),
    headless: true,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  const errors: string[] = [];
  try {
    const sw = await waitForWorker(ctx);
    const extId = new URL(sw.url()).host;
    if (!sw.url().endsWith('/background.js')) fail(`service worker inesperado: ${sw.url()}`);
    if (extId !== DEV_EXTENSION_ID) fail(`ID ${extId} distinto del fijado por la key dev (${DEV_EXTENSION_ID})`);
    const globals = await sw.evaluate(() => ({
      window: typeof (globalThis as { window?: unknown }).window,
      document: typeof (globalThis as { document?: unknown }).document,
      xhr: typeof (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest,
      alarms: typeof chrome.alarms?.create,
    }));
    if (globals.window !== 'undefined' || globals.document !== 'undefined') fail('el SW ve window/document');
    console.log(`SW OK: ${sw.url()} (window=${globals.window}, document=${globals.document}, XHR=${globals.xhr})`);

    const popup: Page = await ctx.newPage();
    popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
    popup.on('console', (m) => {
      if (m.type() === 'error') errors.push(`popup console: ${m.text()}`);
    });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.getByRole('button', { name: 'Entrar (emulador)' }).waitFor({ timeout: 15_000 });
    console.log('Popup OK: el SW respondió el estado (login dev visible).');

    if (E2E) await e2e(ctx, popup);
    if (errors.length > 0) fail(errors.join('\n'));
    console.log('SMOKE OK');
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

async function e2e(ctx: BrowserContext, popup: Page): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Página de prueba</title><p>Hola</p>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await popup.getByPlaceholder('correo@compratuparcela.cl').fill(EMAIL);
    await popup.getByRole('button', { name: 'Entrar (emulador)' }).click();
    await popup.getByRole('button', { name: 'Iniciar jornada' }).waitFor({ timeout: 30_000 });
    console.log(`Login dev + joinOrg OK (${EMAIL}).`);

    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/ruta?token=secreto#x`);
    await popup.getByRole('button', { name: 'Iniciar jornada' }).click();
    await popup.getByRole('button', { name: 'Cerrar jornada' }).waitFor({ timeout: 15_000 });
    await page.bringToFront();
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(10 + i * 5, 10);
      await page.keyboard.press('Shift');
      await page.waitForTimeout(1_000);
    }
    await popup.bringToFront();
    await popup.getByRole('button', { name: 'Cerrar jornada' }).click();
    await popup.getByRole('button', { name: 'Iniciar jornada' }).waitFor({ timeout: 15_000 });
    try {
      await popup.getByText('Todo enviado').waitFor({ timeout: 30_000 });
    } catch {
      const sw = ctx.serviceWorkers()[0];
      const state = sw ? await sw.evaluate(() => chrome.storage.local.get(null)) : null;
      fail(`la cola no se vació. Popup: ${await popup.textContent('#app')}
Estado: ${JSON.stringify(state)}`);
    }

    const sessions = await firestoreDocs('sessions');
    const activity = await firestoreDocs('activity');
    console.log('sessions:', JSON.stringify(sessions));
    console.log('activity:', JSON.stringify(activity));
    const closed = sessions.find((s) => (s.endReason as { stringValue?: string } | undefined)?.stringValue === 'manual');
    if (!closed) fail('no hay sesión cerrada manualmente en Firestore');
    const act = activity[0];
    if (!act) fail('no hay documentos activity en Firestore');
    const keys = Object.keys(act).filter((k) => k !== 'id').sort();
    const expected = ['activeSeconds', 'domains', 'outsideChromeSeconds', 'sessionId', 'slotStart', 'trackedSeconds', 'uid', 'urls'];
    if (JSON.stringify(keys) !== JSON.stringify(expected)) fail(`campos de activity: ${keys.join(',')}`);
    const urls = JSON.stringify(act.urls);
    if (urls.includes('token=') || urls.includes('#x')) fail('se guardó query/hash en urls');
    console.log('E2E OK: sesión creada y cerrada, activity con los 8 campos del modelo.');
  } finally {
    server.close();
  }
}

await main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
