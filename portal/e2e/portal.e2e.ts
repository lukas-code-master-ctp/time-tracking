/**
 * End-to-end test of the admin portal against the Firebase emulators.
 *
 *   npm run e2e:portal      (root: builds functions, then runs this inside
 *   firebase emulators:exec --only auth,firestore,functions,storage --project demo-timetracking)
 *
 * 1. Seeds with the Admin SDK: config/org, config/schedule (relative to now)
 *    and Beto's exception (schedules/colab-beto), 2 collaborators, today's
 *    sessions and activity (Ana with web-meeting blocks: `meetingSeconds`), 1
 *    screenshot (file in Storage + doc).
 * 2. Starts the portal's Vite dev server (development mode → emulators).
 * 3. In Chromium (Playwright): dev login as the bootstrap admin
 *    (`lukas@impulseai.cl`, functions/.env.demo-timetracking), team table
 *    with hours > 0 and "En reunión" (same value as the CSV), collaborator
 *    detail with the "En reunión" card, meeting blocks, timeline and screenshot
 *    (thumbnail + lightbox), invitation, role change, settings; each write is
 *    checked in Firestore. Working hours: schedule columns in Equipo and the
 *    CSV, cards, shading and marks in the detail, a personalized schedule and
 *    "Volver al general" in Colaboradores, and deleting / creating / editing
 *    the general schedule in Configuración. No horizontal scroll at 375 px.
 *    Public privacy policy at /privacidad (no session) and its link from the login.
 * 4. Screenshots (desktop and 375 px, light and dark) in PORTAL_SHOTS_DIR
 *    (default: <tmp>/timetracking-portal-shots).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import {
  CHILE_HOLIDAY_DATES,
  COLLECTIONS,
  EMULATOR_PORTS,
  FIREBASE_DEMO_PROJECT_ID,
  SLOT_MS,
  activityDocId,
  complianceForRange,
  formatDuration,
  meetingSecondsOf,
  secondsToHours,
  screenshotStoragePath,
  slotStartOf,
  type ActivitySlot,
  type DaySchedule,
  type OrgConfig,
  type PersonSchedule,
  type ScheduleConfig,
  type ScreenshotMeta,
  type Session,
  type UserProfile,
  type WeekSchedule,
} from '@timetracking/shared';
import { addDays, formatTime, startOfDay, zonedDate } from '../src/lib/dates.ts';
import { findChromium, NO_CHROMIUM } from '../../scripts/lib/chromium.ts';
import { clearEmulators, uploadJpeg } from '../../scripts/lib/emulators.ts';

const PORTAL = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = FIREBASE_DEMO_PROJECT_ID;
const BUCKET = `${PROJECT}.appspot.com`;
const ADMIN_EMAIL = 'lukas@impulseai.cl'; // BOOTSTRAP_ADMINS in functions/.env.demo-timetracking
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

function chromiumPath(): string {
  return findChromium() ?? fail(NO_CHROMIUM);
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
  /** Ana's seconds in a meeting today (sum of `meetingSeconds`). */
  anaMeetingSeconds: number;
  /** `config/schedule` and Beto's exception (`schedules/colab-beto`). */
  schedule: ScheduleConfig;
  betoSchedule: PersonSchedule;
  anaSession: Session;
  betoSession: Session;
  today: string;
}

/**
 * Turns some of Ana's blocks into web meetings, as extension 0.1.2 writes
 * them: block 1 mostly meeting (with %), block 2 entirely meeting ("—") and
 * block 4 with a short meeting (marker only). Block 0 keeps its high activity.
 */
function withMeetings(slots: ActivitySlot[]): ActivitySlot[] {
  const meet = (s: ActivitySlot): Pick<ActivitySlot, 'domains' | 'urls'> => {
    const inChrome = s.trackedSeconds - s.outsideChromeSeconds;
    return { domains: { 'meet.google.com': inChrome }, urls: [{ url: 'https://meet.google.com/abc-defg-hij', seconds: inChrome }] };
  };
  return slots.map((s, i) => {
    const t = s.trackedSeconds;
    if (i === 1) return { ...s, ...meet(s), activeSeconds: Math.round(t * 0.05), meetingSeconds: Math.round(t * 0.9) };
    if (i === 2) return { ...s, ...meet(s), activeSeconds: 0, meetingSeconds: t };
    if (i === 4) return { ...s, meetingSeconds: Math.min(60, t - s.activeSeconds) };
    return { ...s, meetingSeconds: 0 };
  });
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
  await clearEmulators();

  initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
  const db = getFirestore();
  const now = Date.now();
  // Today in Santiago starts at most ~21 h before; keep the data inside today.
  const dayStart = dayStartMs(now);
  if (now - dayStart < 30 * 60_000) fail('faltan menos de 30 minutos desde la medianoche (hora de Chile): vuelve a ejecutar más tarde.');
  if (startOfDay(addDays(zonedDate(now), 1)) - now < 30 * 60_000) {
    fail('faltan menos de 30 minutos para la medianoche (hora de Chile): vuelve a ejecutar más tarde.');
  }
  const start = Math.max(dayStart, now - 3 * 3_600_000);

  const config: OrgConfig = {
    allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
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
  await db.doc(`users/${beto}`).set(person('beto.diaz@impulseai.cl', 'Beto Díaz'));

  // Ana: open session (live), Beto: closed session.
  const anaSession: Session = { uid: ana, startedAt: start, endedAt: null, endReason: null, lastHeartbeatAt: now - 60_000 };
  // Beto arrives 20 min after Ana (late against his personalized schedule, below).
  const betoStart = start + 20 * 60_000;
  const betoEnd = Math.min(betoStart + 100 * 60_000, now - 60_000);
  const betoSession: Session = { uid: beto, startedAt: betoStart, endedAt: betoEnd, endReason: 'manual', lastHeartbeatAt: betoEnd };
  await db.doc(`sessions/s-ana`).set(anaSession);
  await db.doc(`sessions/s-beto`).set(betoSession);
  const anaSlots = withMeetings(slotsFor(ana, 's-ana', start, now - 60_000, [92, 85, 74, 61, 88, 45, 97, 30, 80]));
  if (anaSlots.length < 5) fail('muy pocos bloques de hoy para sembrar reuniones: vuelve a ejecutar más tarde.');
  const anaMeetingSeconds = anaSlots.reduce((n, s) => n + meetingSecondsOf(s), 0);
  // Beto: blocks as extension 0.1.1 wrote them (no meetingSeconds, read as 0).
  const slots = [...anaSlots, ...slotsFor(beto, 's-beto', betoStart, betoEnd, [35, 55, 20, 65])];

  // Working hours, relative to now so any time of day works (every day of the
  // week the same): general = now − 2 h → now + 2 h with a 20-min lunch (Ana
  // is connected an hour before the entry: outside the schedule); Beto's
  // exception starts when Ana's session did, so he is 20 min late.
  const today = zonedDate(now);
  const clock = (ms: number): string => (zonedDate(ms) === today ? formatTime(ms) : ms < now ? '00:00' : '23:59');
  const plus = (time: string, minutes: number): string => {
    const t = Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) + minutes;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const entry = clock(now - 120 * 60_000);
  const everyDay = (d: DaySchedule): WeekSchedule => ({ mon: d, tue: d, wed: d, thu: d, fri: d, sat: d, sun: d });
  const schedule: ScheduleConfig = {
    week: everyDay({ start: entry, end: clock(now + 120 * 60_000), lunchStart: plus(entry, 30), lunchEnd: plus(entry, 50) }),
    // Today is never a holiday here, so the check does not depend on the date.
    holidays: CHILE_HOLIDAY_DATES.filter((d) => d !== today),
    toleranceMinutes: 5,
    remindersEnabled: true,
    updatedAt: now - 86_400_000,
    updatedBy: 'system',
  };
  await db.doc(`${COLLECTIONS.config}/schedule`).set(schedule);
  const betoSchedule: PersonSchedule = {
    week: everyDay({ start: formatTime(start), end: clock(now + 60 * 60_000), lunchStart: null, lunchEnd: null }),
    updatedAt: now - 86_400_000,
    updatedBy: 'system',
  };
  await db.doc(`${COLLECTIONS.schedules}/${beto}`).set(betoSchedule);
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
  // Same REST upload as the extension (see uploadJpeg in scripts/lib/emulators.ts).
  await uploadJpeg(storagePath, new Uint8Array(jpeg));
  const meta: ScreenshotMeta = { uid: ana, sessionId: 's-ana', takenAt, storagePath, blurred: true, width: 1280, height: 720 };
  await db.doc(`${COLLECTIONS.screenshots}/${shotId}`).set(meta);
  ok(
    `Semilla: config/org, config/schedule (${entry}–${schedule.week.mon!.end}, colación ${schedule.week.mon!.lunchStart}–${schedule.week.mon!.lunchEnd}), ` +
      `horario personalizado de Beto, 2 colaboradores, 2 jornadas, ${slots.length} bloques de actividad ` +
      `(Ana ${formatDuration(anaMeetingSeconds)} en reunión), 1 captura (${storagePath}).`,
  );
  return { ana, beto, shotId, anaMeetingSeconds, schedule, betoSchedule, anaSession, betoSession, today };
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

    // 0. Public privacy policy: direct URL without a session, and the link from the login page.
    await page.goto(`${BASE}/privacidad`);
    await page.getByRole('heading', { level: 1, name: 'Política de privacidad' }).waitFor({ timeout: 30_000 });
    if (await page.getByRole('button', { name: 'Iniciar sesión con Google' }).count()) fail('/privacidad muestra el login');
    await shootAll(page, '00-privacidad');
    ok('Política de privacidad pública en /privacidad (sin sesión).');

    // 1. Login page + dev login as the bootstrap admin (joinOrg creates users/{uid} as admin).
    await page.goto(BASE);
    await page.getByRole('button', { name: 'Iniciar sesión con Google' }).waitFor({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Política de privacidad' }).click();
    await page.getByRole('heading', { level: 1, name: 'Política de privacidad' }).waitFor();
    if (new URL(page.url()).pathname !== '/privacidad') fail(`el enlace del login lleva a ${page.url()}`);
    await page.goBack();
    await page.getByRole('button', { name: 'Iniciar sesión con Google' }).waitFor({ timeout: 30_000 });
    ok('Enlace "Política de privacidad" en el login.');
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
    // "En reunión" column (and totals): Ana's seeded meetings, Beto 0.1.1 data → 0.
    const headers = (await table.locator('thead th').allTextContents()).map((h) => h.trim());
    const meetingCol = headers.indexOf('En reunión');
    if (meetingCol === -1) fail(`la tabla no tiene la columna "En reunión": ${headers.join(' | ')}`);
    const anaMeeting = (await anaRow.locator('td').nth(meetingCol).textContent())?.trim() ?? '';
    const betoMeeting = (await betoRow.locator('td').nth(meetingCol).textContent())?.trim();
    const totalMeeting = (await table.locator('tfoot tr').locator('th, td').nth(meetingCol).textContent())?.trim();
    const expectedMeeting = formatDuration(seeded.anaMeetingSeconds);
    if (anaMeeting !== expectedMeeting || betoMeeting !== '0 min' || totalMeeting !== expectedMeeting) {
      fail(`columna "En reunión": Ana "${anaMeeting}", Beto "${betoMeeting}", total "${totalMeeting}" (esperado ${expectedMeeting})`);
    }
    ok(`Columna "En reunión": Ana ${anaMeeting}, Beto ${betoMeeting} (datos 0.1.1), total ${totalMeeting}.`);
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
    // The CSV and the table agree on the meeting time.
    const [csvHead = '', ...csvLines] = csv.replace(/^\uFEFF/, '').trim().split(/\r\n/);
    const csvCol = csvHead.split(';').indexOf('Horas en reunión');
    const csvAna = csvLines.find((l) => l.startsWith('Ana Rojas;'))?.split(';')[csvCol] ?? '';
    const csvBeto = csvLines.find((l) => l.startsWith('Beto Díaz;'))?.split(';')[csvCol];
    const expectedCsv = String(secondsToHours(seeded.anaMeetingSeconds)).replace('.', ',');
    if (csvCol === -1 || csvAna !== expectedCsv || csvBeto !== '0') fail(`CSV "Horas en reunión": Ana "${csvAna}", Beto "${csvBeto}" (esperado ${expectedCsv})`);
    const m = /^(?:(\d+) h )?(\d+) min$/.exec(anaMeeting);
    const tableMinutes = m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN;
    if (!(Math.abs(Number(csvAna.replace(',', '.')) * 60 - tableMinutes) <= 1)) fail(`CSV (${csvAna} h) y tabla (${anaMeeting}) no coinciden`);
    ok(`CSV exportado (${download.suggestedFilename()}): "Horas en reunión" de Ana ${csvAna} h = ${anaMeeting} de la tabla.`);

    // Schedule columns (general for Ana, exception for Beto): same figures as the shared functions and the CSV.
    const expectFor = (session: Session, week: WeekSchedule) =>
      complianceForRange(seeded.today, seeded.today, [session], week, seeded.schedule.holidays, seeded.schedule.toleranceMinutes, Date.now()).totals;
    const anaC = expectFor(seeded.anaSession, seeded.schedule.week);
    const betoC = expectFor(seeded.betoSession, seeded.betoSchedule.week);
    const col = (h: string): number => {
      const i = headers.indexOf(h);
      if (i === -1) fail(`la tabla no tiene la columna "${h}": ${headers.join(' | ')}`);
      return i;
    };
    const cellText = async (row: typeof anaRow, h: string): Promise<string> => ((await row.locator('td').nth(col(h)).textContent()) ?? '').trim();
    const anaIn = await cellText(anaRow, 'En horario');
    const anaOut = await cellText(anaRow, 'Fuera de horario');
    const betoLate = await cellText(betoRow, 'Atrasos');
    const betoExpected = await cellText(betoRow, 'Esperadas');
    for (const h of ['Esperadas', 'Sin conexión en horario', 'Ausencias']) col(h);
    if (anaIn !== formatDuration(anaC.inScheduleSeconds) || anaOut !== formatDuration(anaC.outsideScheduleSeconds)) {
      fail(`Ana: en horario "${anaIn}", fuera "${anaOut}" (esperado ${formatDuration(anaC.inScheduleSeconds)} / ${formatDuration(anaC.outsideScheduleSeconds)})`);
    }
    if (betoC.lateCount !== 1 || betoLate !== `1${formatDuration(betoC.lateSeconds)}`) fail(`Beto: atrasos "${betoLate}"`);
    if (!betoExpected.includes('personalizado')) fail(`Beto: esperadas "${betoExpected}"`);
    const csvHorario = csvHead.split(';');
    const csvCell = (name: string, h: string): string => csvLines.find((l) => l.startsWith(`${name};`))?.split(';')[csvHorario.indexOf(h)] ?? '';
    const dec = (s: number): string => String(secondsToHours(s)).replace('.', ',');
    if (
      csvCell('Ana Rojas', 'Horario') !== 'General' ||
      csvCell('Ana Rojas', 'Horas en horario') !== dec(anaC.inScheduleSeconds) ||
      csvCell('Beto Díaz', 'Horario') !== 'Personalizado' ||
      csvCell('Beto Díaz', 'Atrasos') !== '1'
    ) {
      fail(`CSV de horario: ${csvHead} / ${csvLines.join(' / ')}`);
    }
    ok(
      `Columnas de horario: Ana en horario ${anaIn}, fuera de horario ${anaOut}; Beto (personalizado) 1 atraso de ${formatDuration(betoC.lateSeconds)}; CSV coherente.`,
    );

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
    // Thumbnails load when they enter the viewport (the day's schedule makes the page longer).
    await page.getByRole('heading', { name: 'Capturas de pantalla' }).scrollIntoViewIfNeeded();
    await thumb.waitFor({ timeout: 15_000 });
    await until('miniatura cargada', () => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0));
    ok(`Detalle: ${await cells.count()} bloques (${withData} con datos), detalle al pasar el cursor, miniatura cargada desde Storage.`);

    // "En reunión": card, meeting color + "—", marker, detail and legend.
    const stats = (await page.getByRole('region', { name: 'Resumen del día' }).textContent()) ?? '';
    if (!stats.includes(`En reunión${formatDuration(seeded.anaMeetingSeconds)}`)) fail(`tarjeta "En reunión": ${stats}`);
    const meetingCells = page.locator('.cell.lvl-meeting');
    const meetingTexts = (await meetingCells.allTextContents()).map((t) => t.trim());
    if (meetingTexts.length !== 2 || meetingTexts[1] !== '—' || !/^\d+$/.test(meetingTexts[0] ?? '')) fail(`bloques en reunión: ${JSON.stringify(meetingTexts)}`);
    if ((await page.locator('.cell.has-meeting:not(.lvl-meeting)').count()) !== 1) fail('falta el marcador del bloque con poca reunión');
    const legend = (await page.getByRole('list', { name: 'Leyenda' }).textContent()) ?? '';
    if (!legend.includes('En reunión')) fail(`leyenda: ${legend}`);
    // Pinned (click) so the detail stays open in the screenshots. From the top of the page: scrolled to the
    // very bottom (the thumbnail step), the detail changing size on hover moves the page under the pointer.
    await page.evaluate(() => window.scrollTo(0, 0));
    await meetingCells.nth(1).click();
    await page.mouse.move(0, 0);
    const meetingDetail = (await page.getByTestId('timeline-detail').textContent()) ?? '';
    if (!meetingDetail.includes('Actividad: —') || !/En reunión\d+ min/.test(meetingDetail)) fail(`detalle del bloque en reunión: ${meetingDetail}`);
    ok(`"En reunión": tarjeta ${formatDuration(seeded.anaMeetingSeconds)}, 2 bloques con su color (${meetingTexts.join(', ')}), marcador, detalle y leyenda.`);

    // Schedule of the day: cards, timeline shading and marks, time outside per session.
    const daySchedule = (await page.getByTestId('day-schedule').textContent()) ?? '';
    if (!daySchedule.includes('Horario general') || !daySchedule.includes('En curso')) fail(`horario del día: ${daySchedule}`);
    const cardsText = (await page.getByRole('region', { name: 'Cumplimiento del día' }).textContent()) ?? '';
    for (const part of [`En horario${formatDuration(anaC.inScheduleSeconds)}`, 'Esperado', 'Atraso', 'Salida anticipadaEn curso', 'Sin conexión en horario']) {
      if (!cardsText.includes(part)) fail(`tarjetas de cumplimiento sin "${part}": ${cardsText}`);
    }
    const lunchCells = await page.locator('.cell.sch-lunch').count();
    const offCells = await page.locator('.cell.sch-off').count();
    const marks = await page.locator('.cell .sch-mark').count();
    if (lunchCells === 0 || marks !== 2) fail(`línea de tiempo con horario: ${lunchCells} bloques de colación, ${marks} marcas`);
    const jornadas = page.getByRole('region', { name: 'Jornadas del día' });
    if (!(await jornadas.getByRole('columnheader', { name: 'Fuera de horario' }).count())) fail('las jornadas no muestran "Fuera de horario"');
    const sessionOutside = ((await jornadas.locator('tbody td').nth(4).textContent()) ?? '').trim();
    if (!sessionOutside.startsWith(formatDuration(anaC.outsideScheduleSeconds))) fail(`jornada fuera de horario: "${sessionOutside}"`);
    ok(`Detalle con horario: tarjetas (en horario ${formatDuration(anaC.inScheduleSeconds)}, en curso), ${lunchCells} bloques de colación, ${offCells} fuera de horario, entrada y salida marcadas, jornada con ${sessionOutside.split('colación')[0]} fuera de horario.`);
    await shootAll(page, '03-colaborador');
    await meetingCells.nth(1).click(); // unpin

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
    await page.getByText('Solo puedes invitar correos @impulseai.cl o @compratuparcela.cl.').waitFor();
    await email.fill('nuevo.colaborador@compratuparcela.cl');
    await page.getByRole('button', { name: 'Invitar' }).click();
    await page.getByText('Invitación creada para nuevo.colaborador@compratuparcela.cl. Comparte el enlace de instalación con la persona.').waitFor();
    const inv = await until('invitación en Firestore', async () => (await getFirestore().doc('invitations/nuevo.colaborador@compratuparcela.cl').get()).data());
    if (inv.status !== 'pending' || inv.invitedBy !== adminUid || typeof inv.invitedAt !== 'number') fail(`invitación: ${JSON.stringify(inv)}`);
    await page.locator('.list-item').filter({ hasText: 'nuevo.colaborador@compratuparcela.cl' }).waitFor();
    // The other Workspace organization is allowed too.
    await email.fill('otra.persona@impulseai.cl');
    await page.getByRole('button', { name: 'Invitar' }).click();
    await page.getByText('Invitación creada para otra.persona@impulseai.cl. Comparte el enlace de instalación con la persona.').waitFor();
    await until('invitación @impulseai.cl en Firestore', async () => (await getFirestore().doc('invitations/otra.persona@impulseai.cl').get()).data());
    ok('Invitaciones creadas en ambos dominios (pending, invitedBy = admin); correo de otro dominio rechazado.');
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

    // Per-person schedule: personalize Ana (exact document), then "Volver al general" (deleted).
    const anaItem = page.locator('.list > .list-item').filter({ hasText: 'Ana Rojas' });
    const betoItem = page.locator('.list > .list-item').filter({ hasText: 'Beto Díaz' });
    if (!(await anaItem.textContent())?.includes('Horario: General')) fail('Ana no aparece con "Horario: General"');
    if (!(await betoItem.textContent())?.includes('Horario: Personalizado')) fail('Beto no aparece con "Horario: Personalizado"');
    await page.getByRole('button', { name: 'Editar horario de Ana Rojas' }).click();
    const anaPanel = page.getByRole('region', { name: 'Horario de Ana Rojas' });
    await anaPanel.getByRole('button', { name: 'Personalizar horario' }).click();
    await anaPanel.getByLabel('Entrada (Lunes)').fill('08:00');
    await anaPanel.getByLabel('Salida (Lunes)').fill('17:00');
    await anaPanel.getByRole('button', { name: 'Guardar horario personalizado' }).click();
    await anaPanel.getByText('Horario personalizado de Ana Rojas guardado.').waitFor();
    const anaSchedule = await until('schedules/colab-ana', async () => (await getFirestore().doc(`schedules/${seeded.ana}`).get()).data());
    const personKeys = Object.keys(anaSchedule).sort().join(',');
    const mon = (anaSchedule.week as WeekSchedule).mon;
    if (personKeys !== 'updatedAt,updatedBy,week' || anaSchedule.updatedBy !== adminUid || mon?.start !== '08:00' || mon.end !== '17:00') {
      fail(`schedules/colab-ana: ${JSON.stringify(anaSchedule)}`);
    }
    await until('chip "Personalizado" de Ana', async () => (await anaItem.textContent())?.includes('Horario: Personalizado'));
    ok('Horario personalizado de Ana guardado desde el portal (week, updatedAt, updatedBy = admin).');
    await shootAll(page, '06b-colaborador-horario');
    await anaPanel.getByRole('button', { name: 'Volver al general' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Volver al general' }).click();
    await anaPanel.getByText('Ana Rojas vuelve a usar el horario general.').waitFor();
    await until('schedules/colab-ana borrado', async () => !(await getFirestore().doc(`schedules/${seeded.ana}`).get()).exists);
    ok('"Volver al general": schedules/colab-ana borrado.');
    await page.getByRole('button', { name: 'Cerrar horario de Ana Rojas' }).click();

    // 6. Settings: exact 6 fields.
    await navTo(page, 'Configuración');
    await page.getByLabel(/Difuminar capturas/).uncheck();
    await page.getByLabel('Conservar capturas (días)').fill('30');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await page.getByText('Configuración guardada.', { exact: false }).waitFor();
    const cfg = (await getFirestore().doc('config/org').get()).data() ?? {};
    const keys = Object.keys(cfg).sort().join(',');
    if (keys !== 'allowedDomains,blurScreenshots,screenshotRetentionDays,screenshotsEnabled,updatedAt,updatedBy') fail(`campos de config/org: ${keys}`);
    if (cfg.blurScreenshots !== false || cfg.screenshotRetentionDays !== 30 || cfg.updatedBy !== adminUid || cfg.screenshotsEnabled !== true) {
      fail(`config/org: ${JSON.stringify(cfg)}`);
    }
    if (JSON.stringify(cfg.allowedDomains) !== JSON.stringify(['impulseai.cl', 'compratuparcela.cl'])) {
      fail(`allowedDomains: ${JSON.stringify(cfg.allowedDomains)}`);
    }
    ok('Configuración guardada con los 6 campos (updatedBy = admin).');

    // Domain list editor: own domain cannot be removed; add + remove another one.
    await page.getByRole('button', { name: 'Cambiar dominios' }).click();
    await page.getByText('si quitas un dominio', { exact: false }).waitFor();
    if (!(await page.getByRole('button', { name: 'Quitar @impulseai.cl' }).isDisabled())) fail('se puede quitar el dominio del propio admin');
    await page.getByLabel('Agregar dominio').fill('Nueva-Empresa.cl');
    await page.getByRole('button', { name: 'Agregar', exact: true }).click();
    await page.getByRole('button', { name: 'Quitar @compratuparcela.cl' }).click();
    await page.getByRole('button', { name: 'Guardar y cambiar dominios' }).click();
    await page.getByText('Configuración guardada.', { exact: false }).waitFor();
    const domains = await until('dominios en Firestore', async () => {
      const d = (await getFirestore().doc('config/org').get()).data()?.allowedDomains as unknown;
      return JSON.stringify(d) === JSON.stringify(['impulseai.cl', 'nueva-empresa.cl']) ? d : undefined;
    });
    ok(`Dominios editados desde el portal: ${JSON.stringify(domains)}.`);
    await shootAll(page, '07b-dominios');
    // Restore the original list (other steps and screenshots expect it).
    await page.getByRole('button', { name: 'Cambiar dominios' }).click();
    await page.getByRole('button', { name: 'Quitar @nueva-empresa.cl' }).click();
    await page.getByLabel('Agregar dominio').fill('compratuparcela.cl');
    await page.getByLabel('Agregar dominio').press('Enter');
    await page.getByRole('button', { name: 'Guardar y cambiar dominios' }).click();
    await until('dominios restaurados', async () => {
      const d = (await getFirestore().doc('config/org').get()).data()?.allowedDomains as unknown;
      return JSON.stringify(d) === JSON.stringify(['impulseai.cl', 'compratuparcela.cl']) ? d : undefined;
    });
    await shootAll(page, '07-configuracion');

    // Working hours from the UI: delete the seeded one, create it from the suggested values, edit and save.
    const scheduleCard = page.getByRole('region', { name: 'Horario', exact: true });
    await scheduleCard.getByRole('button', { name: 'Eliminar horario' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eliminar horario' }).click();
    await scheduleCard.getByText('Sin horario configurado').waitFor();
    await until('config/schedule borrado', async () => !(await getFirestore().doc('config/schedule').get()).exists);
    ok('Horario eliminado desde el portal (config/schedule borrado, con confirmación).');
    await shootAll(page, '09-horario-vacio');
    await scheduleCard.getByRole('button', { name: 'Crear horario' }).click();
    if ((await scheduleCard.getByLabel('Entrada (Lunes)').inputValue()) !== '09:00') fail('el horario sugerido no empieza a las 09:00');
    if ((await scheduleCard.getByLabel('Salida (Viernes)').inputValue()) !== '14:00') fail('el viernes sugerido no termina a las 14:00');
    // Live validation.
    await scheduleCard.getByLabel('Salida (Lunes)').fill('08:00');
    await scheduleCard.getByText('Lunes: la salida debe ser posterior a la entrada (sin cruzar la medianoche).').waitFor();
    await scheduleCard.getByLabel('Salida (Lunes)').fill('18:30');
    await scheduleCard.getByLabel('Entrada (Lunes)').fill('08:30');
    await scheduleCard.getByRole('button', { name: 'Copiar lunes a martes–viernes' }).click();
    await scheduleCard.getByLabel('Tolerancia (minutos)').fill('10');
    await scheduleCard.getByLabel('Agregar feriado').fill('2027-12-31');
    await scheduleCard.getByRole('button', { name: 'Agregar fecha' }).click();
    await scheduleCard.getByText('Feriado agregado').waitFor();
    await shootAll(page, '09-horario-nuevo');
    await scheduleCard.getByRole('button', { name: 'Guardar y activar horario' }).click();
    await scheduleCard.getByText('Horario creado.', { exact: false }).waitFor();
    const saved = await until('config/schedule creado', async () => (await getFirestore().doc('config/schedule').get()).data());
    const scheduleKeys = Object.keys(saved).sort().join(',');
    const savedWeek = saved.week as WeekSchedule;
    const lj = JSON.stringify({ start: '08:30', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' });
    const savedHolidays = saved.holidays as string[];
    if (
      scheduleKeys !== 'holidays,remindersEnabled,toleranceMinutes,updatedAt,updatedBy,week' ||
      (['mon', 'tue', 'wed', 'thu', 'fri'] as const).some((d) => JSON.stringify(savedWeek[d]) !== lj) ||
      savedWeek.sat !== null ||
      savedWeek.sun !== null ||
      saved.toleranceMinutes !== 10 ||
      saved.remindersEnabled !== true ||
      saved.updatedBy !== adminUid ||
      JSON.stringify(savedHolidays) !== JSON.stringify([...new Set([...CHILE_HOLIDAY_DATES, '2027-12-31'])].sort())
    ) {
      fail(`config/schedule: ${JSON.stringify(saved)}`);
    }
    ok(`Horario creado desde el portal con los 6 campos: L–V 08:30–18:30 (copiado del lunes), tolerancia 10, ${savedHolidays.length} feriados.`);
    await shootAll(page, '09-horario-guardado');

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
