/**
 * Smoke test of the built dev extension in a real Chromium (Playwright).
 *
 *   node scripts/smoke.ts          → loads dist-dev, checks the service worker
 *                                    starts (no load errors, no DOM globals)
 *                                    and answers the popup.
 *   node scripts/smoke.ts --e2e    → also: dev login against the emulators,
 *                                    consent page, start a work day, admin
 *                                    enables blurred screenshots, forced
 *                                    pulse + capture (dev debug messages),
 *                                    file in Storage + `screenshots` doc,
 *                                    stop, Firestore documents. Run inside
 *   firebase emulators:exec --only auth,firestore,functions,storage --project demo-timetracking "node extension/scripts/smoke.ts --e2e"
 *
 * Branded Google Chrome ignores `--load-extension` since v137, so this uses
 * Playwright's Chromium: `npx playwright install chromium`, or any cached
 * `ms-playwright/chromium-*` build, or `SMOKE_CHROMIUM=<path to chrome>`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { CONSENT_VERSION, DEFAULT_TIME_ZONE } from '@timetracking/shared';
import { ROOT } from '../build/common.ts';
import { DEV_EXTENSION_ID } from '../build/manifest.ts';
import { findChromium, NO_CHROMIUM } from '../../scripts/lib/chromium.ts';

const E2E = process.argv.includes('--e2e');
const EXT_DIR = join(ROOT, 'dist-dev');
const PROJECT = 'demo-timetracking';
const FIRESTORE = 'http://127.0.0.1:8080';
const STORAGE = 'http://127.0.0.1:9199';
const BUCKET = `${PROJECT}.appspot.com`;
const EMAIL = 'lukas@impulseai.cl'; // BOOTSTRAP_ADMINS in functions/.env.demo-timetracking

function fail(msg: string): never {
  console.error(`SMOKE FALLÓ: ${msg}`);
  process.exit(1);
}

function chromiumPath(): string {
  return findChromium() ?? fail(NO_CHROMIUM);
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

/** Firestore document fields → plain values (enough for these checks). */
function plain(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const f = v as Record<string, unknown>;
    if ('stringValue' in f) out[k] = f.stringValue;
    else if ('integerValue' in f) out[k] = Number(f.integerValue);
    else if ('booleanValue' in f) out[k] = f.booleanValue;
    else if ('nullValue' in f) out[k] = null;
    else out[k] = f;
  }
  return out;
}

async function firestoreDoc(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  if (res.status === 404) return null;
  if (!res.ok) fail(`Firestore ${path}: HTTP ${res.status}`);
  const body = (await res.json()) as { fields?: Record<string, unknown> };
  return plain(body.fields ?? {});
}

/** What an admin does from the portal (here with the emulator's admin bypass). */
async function setOrgConfig(fields: { screenshotsEnabled: boolean; blurScreenshots: boolean }): Promise<void> {
  const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${f}`).join('&');
  const res = await fetch(`${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/config/org?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { booleanValue: v }])),
    }),
  });
  if (!res.ok) fail(`config/org: HTTP ${res.status} ${await res.text()}`);
}

async function storageObjects(prefix: string): Promise<string[]> {
  const res = await fetch(`${STORAGE}/v0/b/${BUCKET}/o?prefix=${encodeURIComponent(prefix)}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  if (!res.ok) fail(`Storage list: HTTP ${res.status}`);
  const body = (await res.json()) as { items?: { name: string }[] };
  return (body.items ?? []).map((i) => i.name);
}

async function storageMeta(path: string): Promise<{ size: string; contentType: string }> {
  const res = await fetch(`${STORAGE}/v0/b/${BUCKET}/o/${encodeURIComponent(path)}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  if (!res.ok) fail(`Storage ${path}: HTTP ${res.status}`);
  return (await res.json()) as { size: string; contentType: string };
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) fail(`tiempo agotado esperando ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Sends a popup/debug message to the service worker from an extension page. */
function sendFrom(page: Page, msg: Record<string, unknown>): Promise<{ ok: boolean; error?: string; debug?: unknown }> {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), msg) as Promise<{ ok: boolean; error?: string; debug?: unknown }>;
}

/** High-contrast stripes: a sharp screenshot has big neighbour differences, a blurred one almost none. */
const STRIPES_PAGE =
  '<!doctype html><title>Página de prueba</title><style>html,body{margin:0;height:100%}' +
  'body{background:repeating-linear-gradient(90deg,#000 0 3px,#fff 3px 6px)}</style><p>Hola</p>';

async function e2e(ctx: BrowserContext, popup: Page): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(STRIPES_PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    // 1. Dev login → joinOrg → the consent page opens by itself.
    const consentOpened = ctx.waitForEvent('page', { predicate: (p) => p.url().endsWith('/consent.html'), timeout: 30_000 });
    await popup.getByLabel('Correo (login de desarrollo)').fill(EMAIL);
    await popup.getByRole('button', { name: 'Entrar (emulador)' }).click();
    await popup.getByRole('button', { name: 'Leer y aceptar el aviso' }).waitFor({ timeout: 30_000 });
    const consent = await consentOpened;
    console.log(`Login dev + joinOrg OK (${EMAIL}); popup pide el aviso y abrió consent.html.`);

    // 2. Accept the notice.
    await consent.getByText('Qué NO se mide').waitFor();
    const accept = consent.getByRole('button', { name: 'Acepto y entiendo' });
    await until('botón Aceptar habilitado', () => accept.isEnabled());
    await accept.click();
    await consent.getByText('¡Listo!').waitFor({ timeout: 15_000 });
    const users = await firestoreDocs('users');
    const me = users.find((u) => (u.email as { stringValue?: string } | undefined)?.stringValue === EMAIL);
    if (!me) fail('no se encontró users/{uid}');
    const uid = me.id as string;
    const profile = await firestoreDoc(`users/${uid}`);
    if (profile?.consentVersion !== CONSENT_VERSION || typeof profile.consentAcceptedAt !== 'number') {
      fail(`consentimiento no guardado: ${JSON.stringify(profile)}`);
    }
    console.log(`Aviso aceptado: users/${uid} con consentVersion ${String(profile.consentVersion)}.`);
    await consent.close();

    // 3. Start the work day on a test page.
    await popup.getByRole('button', { name: 'Iniciar jornada' }).waitFor({ timeout: 15_000 });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/ruta?token=secreto#x`);
    await popup.getByRole('button', { name: 'Iniciar jornada' }).click();
    await popup.getByRole('button', { name: 'Cerrar jornada' }).waitFor({ timeout: 15_000 });
    await popup.getByText('EN JORNADA').waitFor();
    console.log('Jornada iniciada.');

    // 4. The admin enables blurred screenshots.
    await setOrgConfig({ screenshotsEnabled: true, blurScreenshots: true });

    await page.bringToFront();
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(10 + i * 5, 10);
      await page.keyboard.press('Shift');
      await page.waitForTimeout(1_000);
    }

    // 5. Force the pulse and the capture instant (dev-only debug messages).
    const pulse = await sendFrom(popup, { type: 'debug.forcePulse' });
    if (!pulse.ok) fail(`debug.forcePulse: ${pulse.error}`);
    const shot = await sendFrom(popup, { type: 'debug.forceScreenshot' });
    if (!shot.ok || shot.debug !== 'captured') fail(`debug.forceScreenshot: ${JSON.stringify(shot)}`);
    const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    const filter = sw ? await sw.evaluate(() => {
      const c = new OffscreenCanvas(1, 1).getContext('2d')!;
      c.filter = 'blur(2px)';
      return c.filter;
    }) : '?';
    console.log(`Captura tomada (ctx.filter en OffscreenCanvas del SW: "${filter}").`);

    // 6. File in Storage + screenshots doc with the 7 fields.
    const docs = await until('doc screenshots', async () => {
      const d = await firestoreDocs('screenshots');
      return d.length > 0 ? d : null;
    });
    const meta = plain(Object.fromEntries(Object.entries(docs[0]!).filter(([k]) => k !== 'id')));
    const keys = Object.keys(meta).sort().join(',');
    if (keys !== 'blurred,height,sessionId,storagePath,takenAt,uid,width') fail(`campos de screenshots: ${keys}`);
    if (meta.uid !== uid || meta.blurred !== true) fail(`screenshots: ${JSON.stringify(meta)}`);
    if (!(Number(meta.width) > 0 && Number(meta.width) <= 1280)) fail(`ancho inválido ${String(meta.width)}`);
    if (docs[0]!.id !== `${uid}_${Math.floor(Number(meta.takenAt) / 600_000) * 600_000}`) fail(`id no determinista: ${String(docs[0]!.id)}`);
    const objects = await storageObjects(`screenshots/${uid}/`);
    if (!objects.includes(String(meta.storagePath))) {
      fail(`no está el archivo ${String(meta.storagePath)} en Storage (${JSON.stringify(objects)})`);
    }
    const obj = await storageMeta(String(meta.storagePath));
    if (obj.contentType !== 'image/jpeg' || !(Number(obj.size) > 0 && Number(obj.size) < 1024 * 1024)) {
      fail(`archivo inválido: ${JSON.stringify(obj)}`);
    }
    // Blurred for real: the black/white stripes become an even gray (mean ≈ 128,
    // neighbour differences ≈ 0). A blank/white capture would fail the mean.
    const { sharpness, mean } = await popup.evaluate(async (url) => {
      const res = await fetch(url, { headers: { Authorization: 'Bearer owner' } });
      const bmp = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const y = Math.floor(bmp.height / 2);
      const row = g.getImageData(0, y, bmp.width, 1).data;
      let sum = 0;
      let total = 0;
      // Middle half of the row (away from the borders).
      const from = Math.floor(bmp.width / 4);
      const to = Math.floor((bmp.width * 3) / 4);
      for (let x = from; x < to; x++) {
        sum += Math.abs(row[x * 4]! - row[(x - 1) * 4]!);
        total += row[x * 4]!;
      }
      return { sharpness: sum / (to - from), mean: total / (to - from) };
    }, `${STORAGE}/v0/b/${BUCKET}/o/${encodeURIComponent(String(meta.storagePath))}?alt=media`);
    if (sharpness > 15 || mean < 70 || mean > 190) {
      fail(`la captura no parece la página difuminada (nitidez ${sharpness.toFixed(1)}, gris medio ${mean.toFixed(0)})`);
    }
    console.log(
      `Captura OK: ${String(meta.storagePath)} (${obj.size} B, ${String(meta.width)}×${String(meta.height)}, ` +
        `difuminada: nitidez ${sharpness.toFixed(1)}, gris medio ${mean.toFixed(0)}).`,
    );

    // A second forced capture in the same block is idempotent (same id, no overwrite).
    const again = await sendFrom(popup, { type: 'debug.forceScreenshot' });
    if (!again.ok || again.debug !== 'duplicate') fail(`segunda captura del bloque: ${JSON.stringify(again)}`);

    // 7. Close the work day.
    await popup.bringToFront();
    await popup.getByRole('button', { name: 'Cerrar jornada' }).click();
    await popup.getByRole('button', { name: 'Iniciar jornada' }).waitFor({ timeout: 15_000 });
    try {
      await popup.getByText('Todo enviado').waitFor({ timeout: 30_000 });
    } catch {
      const state = sw ? await sw.evaluate(() => chrome.storage.local.get(null)) : null;
      fail(`la cola no se vació. Popup: ${await popup.textContent('#app')}
Estado: ${JSON.stringify(state).slice(0, 4000)}`);
    }

    const sessions = await firestoreDocs('sessions');
    const activity = await firestoreDocs('activity');
    console.log('sessions:', JSON.stringify(sessions));
    console.log('activity:', JSON.stringify(activity));
    const closed = sessions.find((s) => (s.endReason as { stringValue?: string } | undefined)?.stringValue === 'manual');
    if (!closed) fail('no hay sesión cerrada manualmente en Firestore');
    if (meta.sessionId !== closed.id) fail('la captura no apunta a la jornada');
    const act = activity[0];
    if (!act) fail('no hay documentos activity en Firestore');
    const actKeys = Object.keys(act).filter((k) => k !== 'id').sort();
    const expected = ['activeSeconds', 'domains', 'meetingSeconds', 'outsideChromeSeconds', 'sessionId', 'slotStart', 'trackedSeconds', 'uid', 'urls'];
    if (JSON.stringify(actKeys) !== JSON.stringify(expected)) fail(`campos de activity: ${actKeys.join(',')}`);
    // No meeting room was open in the test: 0 meeting seconds (sent as an integer).
    if ((act.meetingSeconds as { integerValue?: string } | undefined)?.integerValue !== '0') {
      fail(`meetingSeconds inesperado: ${JSON.stringify(act.meetingSeconds)}`);
    }
    const urls = JSON.stringify(act.urls);
    if (urls.includes('token=') || urls.includes('#x')) fail('se guardó query/hash en urls');
    const today = await popup.textContent('#app');
    if (!today?.includes('Horas de hoy')) fail('el popup no muestra las horas de hoy');
    if (!today?.includes('En reunión hoy')) fail('el popup no muestra el tiempo en reunión de hoy');
    console.log('E2E OK: aviso, jornada, captura difuminada en Storage + doc, activity con los 8 campos + meetingSeconds, jornada cerrada.');

    await scheduleE2e(ctx, popup, page, uid);
  } finally {
    server.close();
  }
}

/** Plain JSON → Firestore REST value (enough for config/schedule). */
function toValue(v: unknown): Record<string, unknown> {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toValue(x)])) } };
}

/** What an admin saves from the portal: the whole `config/schedule` (emulator admin bypass). */
async function setSchedule(day: { start: string; end: string }, uid: string): Promise<void> {
  const d = { ...day, lunchStart: null, lunchEnd: null };
  const doc = {
    week: { mon: d, tue: d, wed: d, thu: d, fri: d, sat: d, sun: d },
    holidays: [],
    toleranceMinutes: 5,
    remindersEnabled: false,
    updatedAt: Date.now(),
    updatedBy: uid,
  };
  const res = await fetch(`${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/config/schedule`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: (toValue(doc).mapValue as { fields: unknown }).fields }),
  });
  if (!res.ok) fail(`config/schedule: HTTP ${res.status} ${await res.text()}`);
}

const str = (v: unknown): string | undefined => (v as { stringValue?: string } | undefined)?.stringValue;
const int = (v: unknown): number => Number((v as { integerValue?: string } | undefined)?.integerValue ?? 0);

/**
 * One work day with a schedule configured by the admin: starts it, moves the
 * mouse on the page, forces the pulse and a capture, closes it and waits
 * until the close is in Firestore. Returns the session id.
 */
async function scheduledDay(popup: Page, page: Page, expectLabel: RegExp, expectShot: readonly string[]): Promise<string> {
  const before = new Set((await firestoreDocs('sessions')).map((s) => s.id as string));
  await popup.bringToFront();
  await popup.getByRole('button', { name: 'Iniciar jornada' }).click();
  await popup.getByRole('button', { name: 'Cerrar jornada' }).waitFor({ timeout: 15_000 });
  // session.start re-reads config/schedule; the popup refreshes every 2 s.
  await popup.getByText(expectLabel).waitFor({ timeout: 15_000 });
  await popup.getByText(/^Hoy \(/).waitFor();
  await page.bringToFront();
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(20 + i * 5, 20);
    await page.waitForTimeout(1_000);
  }
  const pulse = await sendFrom(popup, { type: 'debug.forcePulse' });
  if (!pulse.ok) fail(`debug.forcePulse: ${pulse.error}`);
  const shot = await sendFrom(popup, { type: 'debug.forceScreenshot' });
  if (!shot.ok || !expectShot.includes(String(shot.debug))) {
    fail(`captura con horario: ${JSON.stringify(shot)} (se esperaba ${expectShot.join(' o ')})`);
  }
  await popup.bringToFront();
  await popup.getByRole('button', { name: 'Cerrar jornada' }).click();
  await popup.getByRole('button', { name: 'Iniciar jornada' }).waitFor({ timeout: 15_000 });
  const session = await until('jornada con horario cerrada en Firestore', async () => {
    const s = (await firestoreDocs('sessions')).find((x) => !before.has(x.id as string));
    return s && str(s.endReason) === 'manual' ? s : null;
  });
  return session.id as string;
}

/**
 * Working hours (spec 2026-09-30-horarios): a schedule that excludes "now"
 * → the popup says "Fuera de horario", the session is recorded but nothing is
 * measured nor captured; a schedule that includes "now" → it measures.
 */
async function scheduleE2e(ctx: BrowserContext, popup: Page, page: Page, uid: string): Promise<void> {
  const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!sw) fail('no se encontró el service worker');
  /** Waits for the upload queue to empty, then sums trackedSeconds of every activity doc. */
  const totalTracked = async (): Promise<number> => {
    await until('cola de envíos vacía', () =>
      sw.evaluate(async () => {
        const q = (await chrome.storage.local.get('tt.queue'))['tt.queue'] as { items?: unknown[] } | undefined;
        return (q?.items?.length ?? 0) === 0;
      }),
    );
    return (await firestoreDocs('activity')).reduce((t, a) => t + int(a.trackedSeconds), 0);
  };
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date()),
  );

  // 1. A one-hour window at the other end of the day: nothing is measured.
  const before = await totalTracked();
  await setSchedule(hour < 12 ? { start: '21:00', end: '22:00' } : { start: '02:00', end: '03:00' }, uid);
  const outside = await scheduledDay(popup, page, /^Fuera de horario: no se mide$/, ['paused']);
  const afterOutside = await totalTracked();
  if (afterOutside !== before) fail(`fuera de horario se midieron ${afterOutside - before} s`);
  const ownDocs = (await firestoreDocs('activity')).filter((a) => str(a.sessionId) === outside);
  if (ownDocs.length > 0) fail(`hay activity de la jornada fuera de horario: ${JSON.stringify(ownDocs)}`);
  console.log(`Horario que excluye ahora: popup "Fuera de horario: no se mide", jornada ${outside} registrada, 0 s medidos, sin captura.`);

  // 2. The whole day: it measures again.
  await setSchedule({ start: '00:00', end: '23:59' }, uid);
  const inside = await scheduledDay(popup, page, /^En horario hasta 23:59$/, ['captured', 'duplicate']);
  const afterInside = await until('trackedSeconds medidos dentro del horario', async () => {
    const t = await totalTracked();
    return t > afterOutside ? t : null;
  });
  const own = (await firestoreDocs('activity')).filter((a) => str(a.sessionId) === inside);
  if (own.length === 0) fail('no hay activity de la jornada dentro del horario');
  console.log(`Horario que incluye ahora: popup "En horario hasta 23:59", jornada ${inside} con ${afterInside - afterOutside} s medidos.`);
}

await main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
