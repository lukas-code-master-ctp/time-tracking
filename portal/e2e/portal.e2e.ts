/**
 * End-to-end test of the admin portal against the Firebase emulators.
 *
 *   npm run e2e:portal      (root: builds functions, then runs this inside
 *   firebase emulators:exec --only auth,firestore,functions,storage --project demo-timetracking)
 *
 * 1. Seeds with the Admin SDK: config/org, 2 collaborators, today's sessions
 *    and activity, 1 screenshot (file in Storage + doc).
 * 2. Starts the portal's Vite dev server (development mode → emulators).
 * 3. In Chromium (Playwright): dev login as the bootstrap admin
 *    (`jefa@compratuparcela.cl`, functions/.env.demo-timetracking), team table
 *    with hours > 0, collaborator detail with timeline and screenshot
 *    (thumbnail + lightbox), invitation, role change, settings; each write is
 *    checked in Firestore. No horizontal scroll at 375 px.
 * 4. Screenshots (desktop and 375 px, light and dark) in PORTAL_SHOTS_DIR
 *    (default: <tmp>/timetracking-portal-shots).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import {
  COLLECTIONS,
  EMULATOR_PORTS,
  FIREBASE_DEMO_PROJECT_ID,
  SLOT_MS,
  activityDocId,
  screenshotStoragePath,
  slotStartOf,
  type ActivitySlot,
  type OrgConfig,
  type ScreenshotMeta,
  type Session,
  type UserProfile,
} from '@timetracking/shared';
import { startOfDay, zonedDate } from '../src/lib/dates.ts';

const PORTAL = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = FIREBASE_DEMO_PROJECT_ID;
const BUCKET = `${PROJECT}.appspot.com`;
const ADMIN_EMAIL = 'jefa@compratuparcela.cl'; // BOOTSTRAP_ADMINS in functions/.env.demo-timetracking
const PORT = 5174;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.PORTAL_SHOTS_DIR ?? join(tmpdir(), 'timetracking-portal-shots');
const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 375, height: 812 };

process.env.FIRESTORE_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.auth}`;
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.storage}`;

function fail(msg: string): never {
  console.error(`E2E PORTAL FALLÓ: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`✔ ${msg}`);
}

function chromiumPath(): string | undefined {
  if (process.env.SMOKE_CHROMIUM) return process.env.SMOKE_CHROMIUM;
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return bundled;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '', '.cache'), 'ms-playwright');
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort().reverse() : [];
  for (const dir of dirs) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(cache, dir, exe);
      if (existsSync(p)) return p;
    }
  }
  fail('no se encontró Chromium de Playwright. Ejecuta `npx playwright install chromium` o define SMOKE_CHROMIUM.');
}

async function emulatorsUp(): Promise<void> {
  try {
    const res = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    fail(`el emulador de Firestore no responde en ${process.env.FIRESTORE_EMULATOR_HOST}. Ejecuta \`npm run e2e:portal\` desde la raíz.`);
  }
}

// ---------- seed ----------

interface Seed {
  ana: string;
  beto: string;
  shotId: string;
}

function slotsFor(uid: string, sessionId: string, start: number, end: number, pattern: readonly number[]): ActivitySlot[] {
  const out: ActivitySlot[] = [];
  let i = 0;
  for (let s = slotStartOf(start); s < end; s += SLOT_MS, i++) {
    const tracked = Math.floor((Math.min(end, s + SLOT_MS) - Math.max(start, s)) / 1000);
    if (tracked <= 0) continue;
    const pct = pattern[i % pattern.length]!;
    const outside = i % 4 === 3 ? Math.floor(tracked / 3) : 0;
    const docs = Math.floor((tracked - outside) * 0.6);
    const mail = tracked - outside - docs;
    out.push({
      uid,
      sessionId,
      slotStart: s,
      trackedSeconds: tracked,
      activeSeconds: Math.floor((tracked * pct) / 100),
      outsideChromeSeconds: outside,
      domains: { 'docs.google.com': docs, 'mail.google.com': mail },
      urls: [
        { url: 'https://docs.google.com/document/d/informe-mensual/edit', seconds: docs },
        { url: 'https://mail.google.com/mail/u/0/', seconds: mail },
      ],
    });
  }
  return out;
}

async function seed(browser: Browser): Promise<Seed> {
  // Clean slate (emulators:exec starts empty, but the script may run against running emulators).
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

  initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
  const db = getFirestore();
  const now = Date.now();
  // Today in Santiago starts at most ~21 h before; keep the data inside today.
  const dayStart = dayStartMs(now);
  if (now - dayStart < 30 * 60_000) fail('faltan menos de 30 minutos desde la medianoche (hora de Chile): vuelve a ejecutar más tarde.');
  const start = Math.max(dayStart, now - 3 * 3_600_000);

  const config: OrgConfig = {
    allowedDomain: 'compratuparcela.cl',
    screenshotsEnabled: true,
    blurScreenshots: true,
    screenshotRetentionDays: 90,
    updatedAt: now - 86_400_000,
    updatedBy: 'system',
  };
  await db.doc(`${COLLECTIONS.config}/org`).set(config);

  const person = (email: string, displayName: string): UserProfile => ({
    email,
    displayName,
    photoURL: null,
    role: 'member',
    status: 'active',
    createdAt: now - 7 * 86_400_000,
    consentAcceptedAt: now - 7 * 86_400_000,
    consentVersion: '2026-09-29',
  });
  const ana = 'colab-ana';
  const beto = 'colab-beto';
  await db.doc(`users/${ana}`).set(person('ana.rojas@compratuparcela.cl', 'Ana Rojas'));
  await db.doc(`users/${beto}`).set(person('beto.diaz@compratuparcela.cl', 'Beto Díaz'));

  // Ana: open session (live), Beto: closed session.
  const anaSession: Session = { uid: ana, startedAt: start, endedAt: null, endReason: null, lastHeartbeatAt: now - 60_000 };
  const betoEnd = Math.min(start + 100 * 60_000, now - 60_000);
  const betoSession: Session = { uid: beto, startedAt: start, endedAt: betoEnd, endReason: 'manual', lastHeartbeatAt: betoEnd };
  await db.doc(`sessions/s-ana`).set(anaSession);
  await db.doc(`sessions/s-beto`).set(betoSession);
  const slots = [
    ...slotsFor(ana, 's-ana', start, now - 60_000, [92, 85, 74, 61, 88, 45, 97, 30, 80]),
    ...slotsFor(beto, 's-beto', start, betoEnd, [35, 55, 20, 65]),
  ];
  const batch = db.batch();
  for (const s of slots) batch.set(db.doc(`${COLLECTIONS.activity}/${activityDocId(s.uid, s.slotStart)}`), s);
  await batch.commit();

  // One screenshot: a JPEG rendered by the browser, uploaded like the extension does.
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(
    '<body style="margin:0;font:32px system-ui;background:linear-gradient(135deg,#dbeafe,#fef3c7);display:grid;place-items:center;height:100vh">' +
      '<div style="background:#fff;padding:40px 60px;border-radius:16px;box-shadow:0 4px 20px #0002">Informe mensual — docs.google.com</div></body>',
  );
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 70 });
  await page.close();
  const takenAt = Math.min(start + 4 * 60_000, now - 60_000);
  const shotId = `${ana}_${slotStartOf(takenAt)}`;
  const storagePath = screenshotStoragePath(ana, takenAt, shotId);
  // Same REST upload as the extension (extension/src/background/firebase.ts), with the
  // emulator's owner token instead of the collaborator's ID token. Firebase Storage
  // adds a download token to these uploads, which the portal's getDownloadURL needs.
  const upload = await fetch(
    `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}/v0/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(storagePath)}`,
    { method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'image/jpeg' }, body: new Uint8Array(jpeg) },
  );
  if (!upload.ok) fail(`subida de la captura: HTTP ${upload.status} ${await upload.text()}`);
  const meta: ScreenshotMeta = { uid: ana, sessionId: 's-ana', takenAt, storagePath, blurred: true, width: 1280, height: 720 };
  await db.doc(`${COLLECTIONS.screenshots}/${shotId}`).set(meta);
  ok(`Semilla: config/org, 2 colaboradores, 2 jornadas, ${slots.length} bloques de actividad, 1 captura (${storagePath}).`);
  return { ana, beto, shotId };
}

/** Start of today in America/Santiago, with the portal's own helper (same code as the UI). */
function dayStartMs(now: number): number {
  return startOfDay(zonedDate(now));
}

// ---------- browser helpers ----------

async function shoot(page: Page, name: string, size: { width: number; height: number }, scheme: 'light' | 'dark', fullPage = true): Promise<void> {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${name}-${size.width <= 400 ? 'movil' : 'escritorio'}-${scheme === 'dark' ? 'oscuro' : 'claro'}.png`), fullPage });
  if (size.width <= 400) {
    const overflow = await page.evaluate(() => {
      const excess = document.documentElement.scrollWidth - window.innerWidth;
      if (excess <= 0) return null;
      // Widest offenders outside an internal scroll container, to explain the failure.
      const culprits = [...document.querySelectorAll<HTMLElement>('body *')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest('.table-wrap'))
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
      return `${excess}px (${culprits.join(', ')})`;
    });
    if (overflow) fail(`${name}: scroll horizontal de ${overflow} a ${size.width}px`);
  }
}

async function shootAll(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await shoot(page, name, DESKTOP, scheme);
    await shoot(page, name, MOBILE, scheme);
  }
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: 'light' });
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) fail(`tiempo agotado esperando ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function navTo(page: Page, label: string): Promise<void> {
  const size = page.viewportSize();
  if (size && size.width <= 860) await page.getByRole('button', { name: 'Menú' }).click();
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: label }).click();
}

// ---------- main ----------

async function main(): Promise<void> {
  await emulatorsUp();
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true });
  let server: ViteDevServer | null = null;
  const errors: string[] = [];
  try {
    const seeded = await seed(browser);

    server = await createServer({
      configFile: join(PORTAL, 'vite.config.ts'),
      root: PORTAL,
      mode: 'development',
      logLevel: 'warn',
      server: { host: '127.0.0.1', port: PORT, strictPort: true },
    });
    await server.listen();
    ok(`Vite dev del portal en ${BASE}`);

    const context = await browser.newContext({ viewport: DESKTOP, locale: 'es-CL', timezoneId: 'America/Santiago' });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });

    // 1. Login page + dev login as the bootstrap admin (joinOrg creates users/{uid} as admin).
    await page.goto(BASE);
    await page.getByRole('button', { name: 'Iniciar sesión con Google' }).waitFor({ timeout: 30_000 });
    await shootAll(page, '01-login');
    await page.getByLabel('Correo simulado').fill(ADMIN_EMAIL);
    await page.getByRole('button', { name: 'Entrar (emulador)' }).click();

    // 2. Team table with hours > 0.
    const table = page.getByRole('table');
    await table.waitFor({ timeout: 30_000 });
    const anaRow = table.getByRole('row').filter({ hasText: 'Ana Rojas' });
    const betoRow = table.getByRole('row').filter({ hasText: 'Beto Díaz' });
    await anaRow.waitFor();
    const anaHours = (await anaRow.locator('td').nth(1).locator('.strong').textContent())?.trim() ?? '';
    const betoHours = (await betoRow.locator('td').nth(1).locator('.strong').textContent())?.trim() ?? '';
    if (!anaHours || anaHours === '0 min') fail(`horas de Ana = "${anaHours}"`);
    if (!betoHours || betoHours === '0 min') fail(`horas de Beto = "${betoHours}"`);
    if (!(await anaRow.textContent())?.includes('En jornada')) fail('Ana no aparece "En jornada"');
    if (!(await betoRow.textContent())?.includes('Fuera')) fail('Beto no aparece "Fuera"');
    const anaPct = await anaRow.locator('.meter-value').textContent();
    ok(`Tabla del equipo: Ana ${anaHours} (${anaPct}, en jornada), Beto ${betoHours} (fuera).`);
    const users = await getFirestore().collection('users').where('email', '==', ADMIN_EMAIL).get();
    const adminUid = users.docs[0]?.id;
    if (!adminUid || users.docs[0]!.data().role !== 'admin') fail('joinOrg no creó al admin bootstrap');
    await shootAll(page, '02-equipo');

    // CSV export (Excel in Spanish: ";" and BOM).
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar CSV' }).click()]);
    const csvPath = join(SHOTS, download.suggestedFilename());
    await download.saveAs(csvPath);
    const csv = readFileSync(csvPath, 'utf8');
    if (!csv.startsWith('﻿Nombre;Correo;Estado;') || !csv.includes('Ana Rojas;ana.rojas@compratuparcela.cl;En jornada;')) {
      fail(`CSV inesperado: ${csv.slice(0, 200)}`);
    }
    ok(`CSV exportado (${download.suggestedFilename()}).`);

    // 3. Collaborator detail: timeline + screenshot + lightbox.
    await anaRow.getByRole('link').click();
    await page.getByRole('heading', { name: 'Ana Rojas' }).waitFor();
    await page.getByRole('heading', { name: 'Línea de tiempo' }).waitFor();
    const cells = page.getByTestId('timeline-cell');
    await cells.first().waitFor();
    const withData = await page.locator('.cell:not(.lvl-none)').count();
    if (withData === 0) fail('la línea de tiempo no tiene bloques con datos');
    await page.locator('.cell.lvl-high').first().hover();
    const detail = (await page.getByTestId('timeline-detail').textContent()) ?? '';
    if (!detail.includes('% de actividad') || !detail.includes('docs.google.com')) fail(`detalle del bloque: ${detail}`);
    const thumb = page.getByTestId('screenshot-thumb');
    await thumb.waitFor({ timeout: 15_000 });
    await until('miniatura cargada', () => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0));
    ok(`Detalle: ${await cells.count()} bloques (${withData} con datos), detalle al pasar el cursor, miniatura cargada desde Storage.`);
    await shootAll(page, '03-colaborador');

    await page.getByRole('button', { name: /Captura de las .* Ampliar/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const big = page.getByTestId('lightbox-img');
    await big.waitFor();
    await until('imagen ampliada', () => big.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 1280));
    if (!(await dialog.textContent())?.includes('Difuminada')) fail('el lightbox no indica "Difuminada"');
    // Viewport only: the modal is fixed, a full-page capture would misplace it.
    await shoot(page, '04-lightbox', DESKTOP, 'light', false);
    await shoot(page, '04-lightbox', MOBILE, 'dark', false);
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    ok('Lightbox con la captura (1280 px) y "Difuminada"; Esc lo cierra.');

    // 4. Invitations: domain validation + create.
    await navTo(page, 'Invitaciones');
    const email = page.getByLabel('Correo de la persona');
    await email.fill('alguien@gmail.com');
    await page.getByRole('button', { name: 'Invitar' }).click();
    await page.getByText('Solo puedes invitar correos @compratuparcela.cl.').waitFor();
    await email.fill('nuevo.colaborador@compratuparcela.cl');
    await page.getByRole('button', { name: 'Invitar' }).click();
    await page.getByText('Invitación enviada a nuevo.colaborador@compratuparcela.cl.').waitFor();
    const inv = await until('invitación en Firestore', async () => (await getFirestore().doc('invitations/nuevo.colaborador@compratuparcela.cl').get()).data());
    if (inv.status !== 'pending' || inv.invitedBy !== adminUid || typeof inv.invitedAt !== 'number') fail(`invitación: ${JSON.stringify(inv)}`);
    await page.locator('.list-item').filter({ hasText: 'nuevo.colaborador@compratuparcela.cl' }).waitFor();
    ok('Invitación creada (pending, invitedBy = admin); correo de otro dominio rechazado.');
    await shootAll(page, '05-invitaciones');

    // 5. Collaborators: role change with confirmation.
    await navTo(page, 'Colaboradores');
    await page.getByLabel('Rol de Beto Díaz').selectOption('admin');
    await page.getByRole('dialog').getByRole('button', { name: 'Hacer administrador' }).click();
    await page.getByText('Cambios guardados para Beto Díaz.').waitFor();
    const beto = (await getFirestore().doc(`users/${seeded.beto}`).get()).data();
    if (beto?.role !== 'admin') fail(`rol de Beto: ${String(beto?.role)}`);
    ok('Rol de Beto cambiado a administrador (con confirmación).');
    await shootAll(page, '06-colaboradores');

    // 6. Settings: exact 6 fields.
    await navTo(page, 'Configuración');
    await page.getByLabel(/Difuminar capturas/).uncheck();
    await page.getByLabel('Conservar capturas (días)').fill('30');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await page.getByText('Configuración guardada.', { exact: false }).waitFor();
    const cfg = (await getFirestore().doc('config/org').get()).data() ?? {};
    const keys = Object.keys(cfg).sort().join(',');
    if (keys !== 'allowedDomain,blurScreenshots,screenshotRetentionDays,screenshotsEnabled,updatedAt,updatedBy') fail(`campos de config/org: ${keys}`);
    if (cfg.blurScreenshots !== false || cfg.screenshotRetentionDays !== 30 || cfg.updatedBy !== adminUid || cfg.screenshotsEnabled !== true) {
      fail(`config/org: ${JSON.stringify(cfg)}`);
    }
    ok('Configuración guardada con los 6 campos (updatedBy = admin).');
    await shootAll(page, '07-configuracion');

    // Mobile menu open (navigation on phones).
    await page.setViewportSize(MOBILE);
    await page.getByRole('button', { name: 'Menú' }).click();
    await page.getByRole('navigation', { name: 'Principal' }).waitFor();
    await shoot(page, '08-menu', MOBILE, 'light');
    await shoot(page, '08-menu', MOBILE, 'dark');

    // Unexpected console errors fail the run.
    if (errors.length > 0) fail(`errores en la página:\n${errors.join('\n')}`);
    console.log(`E2E PORTAL OK. Capturas en ${SHOTS}`);
  } finally {
    await browser.close();
    await server?.close();
  }
}

await main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
process.exit(0);
