/**
 * Integrated end-to-end test: portal (admin) + extension (collaborator)
 * against the Firebase emulators, in the real order of use.
 *
 *   npm run e2e   (root: builds functions and the dev extension, then runs this
 *   inside firebase emulators:exec --only auth,firestore,functions,storage)
 *
 * 1. Admin, in the portal (UI): dev login as the bootstrap admin → turns on
 *    blurred screenshots in Configuración → creates the working hours in
 *    Configuración → Horario from the suggested values, with today's weekday
 *    as a workday from an hour ago to 23:59 without lunch (so "now" is in
 *    working hours; reminders off, today's holiday removed if it is one) →
 *    invites the collaborator in Invitaciones (placeholder install link
 *    warning visible).
 * 2. Collaborator, in the extension (Chromium with dist-dev): dev login with
 *    the invited e-mail → joinOrg (member, invitation accepted) → notice →
 *    starts the work day → the popup says "En horario hasta 23:59" → real
 *    keyboard/mouse activity on a local page for ~70 s → forced pulse +
 *    forced capture → closes the work day → queue empty.
 * 3. A web meeting cannot be joined here (no real Meet/Zoom room), so two
 *    blocks with `meetingSeconds` (a 20-min daily, as extension 0.1.2 writes
 *    them) are seeded for the collaborator right before the measured session
 *    (inside the schedule, after the entry).
 * 4. Admin, in the portal: the collaborator appears with hours > 0, the
 *    seeded time in the "En reunión" column and the schedule columns
 *    (Esperadas, En horario, Fuera de horario, Atrasos, Sin conexión en
 *    horario, Ausencias) with the same figures as the shared compliance
 *    functions; the detail shows the day's schedule and compliance cards,
 *    the "En reunión" card, the meeting blocks (color, "—") and the measured
 *    block with the local site, and the screenshot (thumbnail + lightbox
 *    "Difuminada").
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import {
  CHILE_HOLIDAY_DATES,
  CONSENT_VERSION,
  SLOT_MS,
  WEEKDAY_NAMES,
  activityDocId,
  complianceForRange,
  formatDuration,
  readScheduleConfig,
  slotStartOf,
  weekdayOfDateKey,
  type Session,
} from '@timetracking/shared';
import { formatTime, startOfDay, zonedDate, zonedParts } from '../portal/src/lib/dates.ts';
import { EXTENSION_DEV_DIR, launchExtension, sendFrom, startPortal, type ExtensionBrowser } from './lib/browser.ts';
import { chromiumPath } from './lib/chromium.ts';
import {
  ADMIN_EMAIL,
  assertEmulators,
  clearEmulators,
  firestoreDoc,
  firestoreDocs,
  firestoreWrite,
  storageMeta,
  storageObjects,
  until,
  useEmulatorEnv,
} from './lib/emulators.ts';

const PORT = 5175;
const BASE = `http://127.0.0.1:${PORT}`;
const COLLAB = 'camila.perez@compratuparcela.cl';
const COLLAB_NAME = 'camila.perez'; // joinOrg: name of the (fake) Google token = local part
const WORK_MS = 70_000; // > 1 min so the portal shows "1 min" and not "0 min"

function ok(msg: string): void {
  console.log(`✔ ${msg}`);
}

const PAGE =
  '<!doctype html><html lang="es"><title>Planilla de prueba</title>' +
  '<body style="margin:0;font:18px system-ui;background:repeating-linear-gradient(90deg,#000 0 3px,#fff 3px 6px)">' +
  '<main style="margin:80px auto;max-width:600px;background:#fff;padding:24px"><h1>Planilla de prueba</h1>' +
  '<textarea aria-label="Notas" rows="6" style="width:100%"></textarea></main></body></html>';

async function navTo(page: Page, label: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: label }).click();
}

async function main(): Promise<void> {
  useEmulatorEnv();
  await assertEmulators({ functions: true });
  if (!existsSync(join(EXTENSION_DEV_DIR, 'manifest.json'))) throw new Error('falta extension/dist-dev: npm run build:dev -w extension');
  await clearEmulators();

  const site = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const sitePort = (site.address() as { port: number }).port;

  let portal: ViteDevServer | null = null;
  let ext: ExtensionBrowser | null = null;
  const adminBrowser = await chromium.launch({ executablePath: chromiumPath(), headless: true });
  const errors: string[] = [];
  try {
    portal = await startPortal(PORT);
    ok(`Portal dev en ${BASE}`);

    // ---------- 1. Admin: login, settings, invitation (portal UI) ----------
    const adminCtx = await adminBrowser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'es-CL', timezoneId: 'America/Santiago' });
    const admin = await adminCtx.newPage();
    admin.on('pageerror', (e) => errors.push(`portal: ${e.message}`));
    admin.on('console', (m) => {
      if (m.type() === 'error') errors.push(`portal console: ${m.text()}`);
    });
    await admin.goto(BASE);
    await admin.getByLabel('Correo simulado').fill(ADMIN_EMAIL);
    await admin.getByRole('button', { name: 'Entrar (emulador)' }).click();
    await admin.getByRole('heading', { name: 'Equipo', level: 1 }).waitFor({ timeout: 30_000 });
    const adminUid = (await firestoreDocs('users')).find((u) => u.email === ADMIN_EMAIL && u.role === 'admin')?.id;
    if (!adminUid) throw new Error('joinOrg no creó al admin bootstrap');
    ok(`Admin ${ADMIN_EMAIL} dentro del portal (joinOrg → admin).`);

    await navTo(admin, 'Configuración');
    await admin.getByLabel(/Tomar capturas/).check();
    await admin.getByLabel(/Difuminar capturas/).check();
    await admin.getByRole('button', { name: 'Guardar cambios' }).click();
    await admin.getByText('Configuración guardada.', { exact: false }).waitFor();
    const cfg = await firestoreDoc('config/org');
    if (cfg?.screenshotsEnabled !== true || cfg.blurScreenshots !== true || cfg.updatedBy !== adminUid) {
      throw new Error(`config/org: ${JSON.stringify(cfg)}`);
    }
    ok('Configuración: capturas difuminadas activadas desde el portal.');

    // Working hours that include "now": today's weekday from an hour ago (or 00:00) to 23:59, without lunch.
    const scheduleAt = Date.now();
    const wall = zonedParts(scheduleAt);
    if (wall.hour * 60 + wall.minute >= 23 * 60 + 50) {
      throw new Error('faltan menos de 10 minutos para la medianoche (hora de Chile): el horario de hoy no alcanzaría; vuelve a ejecutar más tarde.');
    }
    const today = zonedDate(scheduleAt);
    const entry = zonedDate(scheduleAt - 3_600_000) === today ? formatTime(scheduleAt - 3_600_000) : '00:00';
    const weekday = weekdayOfDateKey(today);
    const dayName = WEEKDAY_NAMES[weekday];
    const scheduleCard = admin.getByRole('region', { name: 'Horario', exact: true });
    await scheduleCard.getByText('Sin horario configurado').waitFor();
    await scheduleCard.getByRole('button', { name: 'Crear horario' }).click();
    const dayRow = scheduleCard.getByTestId(`day-${weekday}`);
    const workday = dayRow.locator('.week-day-name input[type="checkbox"]');
    if (!(await workday.isChecked())) await workday.check();
    await dayRow.getByLabel(/^Entrada/).fill(entry);
    await dayRow.getByLabel(/^Salida/).fill('23:59');
    const lunch = dayRow.locator('.lunch-toggle input[type="checkbox"]');
    if (await lunch.isChecked()) await lunch.uncheck();
    // Deterministic run: no notification while the collaborator logs in after the entry.
    await scheduleCard.getByRole('checkbox', { name: /^Recordatorios/ }).uncheck();
    const holidayIndex = CHILE_HOLIDAY_DATES.indexOf(today);
    if (holidayIndex !== -1) {
      await scheduleCard.getByRole('list', { name: 'Feriados' }).getByRole('listitem').nth(holidayIndex).getByRole('button', { name: /^Quitar feriado/ }).click();
    }
    await scheduleCard.getByRole('button', { name: 'Guardar y activar horario' }).click();
    await scheduleCard.getByText('Horario creado.', { exact: false }).waitFor();
    const schedule = readScheduleConfig(await until('config/schedule', () => firestoreDoc('config/schedule')));
    const expectedDay = JSON.stringify({ start: entry, end: '23:59', lunchStart: null, lunchEnd: null });
    if (
      !schedule ||
      JSON.stringify(schedule.week[weekday]) !== expectedDay ||
      schedule.holidays.includes(today) ||
      schedule.remindersEnabled !== false ||
      schedule.updatedBy !== adminUid
    ) {
      throw new Error(`config/schedule: ${JSON.stringify(schedule)}`);
    }
    ok(`Horario creado desde el portal: ${dayName.toLowerCase()} ${entry}–23:59 sin colación (incluye ahora), ${schedule.holidays.length} feriados, tolerancia ${schedule.toleranceMinutes} min.`);

    await navTo(admin, 'Invitaciones');
    await admin.getByTestId('install-url-warning').waitFor();
    await admin.getByLabel('Correo de la persona').fill(COLLAB);
    await admin.getByRole('button', { name: 'Invitar' }).click();
    await admin.getByText(`Invitación creada para ${COLLAB}. Comparte el enlace de instalación con la persona.`).waitFor();
    const inv = await until('invitación pendiente', () => firestoreDoc(`invitations/${COLLAB}`));
    if (inv.status !== 'pending' || inv.invitedBy !== adminUid) throw new Error(`invitación: ${JSON.stringify(inv)}`);
    ok(`Invitación a ${COLLAB} creada desde el portal (pending; aviso de enlace de instalación de ejemplo visible).`);

    // ---------- 2. Collaborator: extension ----------
    ext = await launchExtension();
    const { ctx, extId } = ext;
    const popup = await ctx.newPage();
    popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    const consentOpened = ctx.waitForEvent('page', { predicate: (p) => p.url().endsWith('/consent.html'), timeout: 30_000 });
    await popup.getByLabel('Correo (login de desarrollo)').fill(COLLAB);
    await popup.getByRole('button', { name: 'Entrar (emulador)' }).click();
    await popup.getByRole('button', { name: 'Leer y aceptar el aviso' }).waitFor({ timeout: 30_000 });
    const consent = await consentOpened;
    const accept = consent.getByRole('button', { name: 'Acepto y entiendo' });
    await until('botón Aceptar habilitado', () => accept.isEnabled());
    await accept.click();
    await consent.getByText('¡Listo!').waitFor({ timeout: 15_000 });
    await consent.close();
    const me = (await firestoreDocs('users')).find((u) => u.email === COLLAB);
    if (!me || me.role !== 'member' || me.consentVersion !== CONSENT_VERSION) throw new Error(`users del colaborador: ${JSON.stringify(me)}`);
    const uid = me.id;
    const accepted = await firestoreDoc(`invitations/${COLLAB}`);
    if (accepted?.status !== 'accepted') throw new Error(`la invitación no quedó aceptada: ${JSON.stringify(accepted)}`);
    ok(`Extensión: login dev de ${COLLAB} → member (invitación aceptada) y aviso aceptado.`);

    const work = await ctx.newPage();
    await work.goto(`http://127.0.0.1:${sitePort}/planilla/semana?token=secreto#fila-3`);
    await popup.getByRole('button', { name: 'Iniciar jornada' }).click();
    await popup.getByRole('button', { name: 'Cerrar jornada' }).waitFor({ timeout: 15_000 });
    const startedAt = Date.now();
    // session.start reads config/schedule; the popup refreshes every 2 s.
    await popup.getByText('En horario hasta 23:59', { exact: true }).waitFor({ timeout: 15_000 });
    const todayLine = ((await popup.getByText(/^Hoy \(/).textContent()) ?? '').trim();
    if (todayLine !== `Hoy (${dayName.toLowerCase()}): ${entry}–23:59`) throw new Error(`horario de hoy en el popup: "${todayLine}"`);
    ok(`Jornada iniciada; el popup dice "En horario hasta 23:59" y "${todayLine}".`);

    await work.bringToFront();
    const notes = work.getByLabel('Notas');
    let i = 0;
    while (Date.now() - startedAt < WORK_MS) {
      await work.mouse.move(100 + (i % 40) * 10, 200 + (i % 7) * 15);
      if (i % 3 === 0) await notes.press('a');
      await work.waitForTimeout(1_000);
      i++;
    }
    const pulse = await sendFrom(popup, { type: 'debug.forcePulse' });
    if (!pulse.ok) throw new Error(`debug.forcePulse: ${pulse.error}`);
    // The block's random instant may already have passed during the ~70 s (the
    // 30 s pulse then took the capture by itself): "duplicate" is fine too.
    const shot = await sendFrom(popup, { type: 'debug.forceScreenshot' });
    if (!shot.ok || (shot.debug !== 'captured' && shot.debug !== 'duplicate')) throw new Error(`debug.forceScreenshot: ${JSON.stringify(shot)}`);
    ok(
      `~${Math.round((Date.now() - startedAt) / 1000)} s de actividad real en la página local; ` +
        (shot.debug === 'captured' ? 'captura forzada.' : 'la captura del bloque ya la había tomado el pulso normal.'),
    );

    await popup.bringToFront();
    await popup.getByRole('button', { name: 'Cerrar jornada' }).click();
    await popup.getByRole('button', { name: 'Iniciar jornada' }).waitFor({ timeout: 15_000 });
    await popup.getByText('Todo enviado').waitFor({ timeout: 30_000 });

    const sessions = (await firestoreDocs('sessions')).filter((s) => s.uid === uid);
    const closed = sessions.find((s) => s.endReason === 'manual' && typeof s.endedAt === 'number');
    if (!closed || Number(closed.endedAt) - Number(closed.startedAt) < 60_000) throw new Error(`jornada: ${JSON.stringify(sessions)}`);
    const activity = (await firestoreDocs('activity')).filter((a) => a.uid === uid);
    const active = activity.reduce((n, a) => n + Number(a.activeSeconds), 0);
    const tracked = activity.reduce((n, a) => n + Number(a.trackedSeconds), 0);
    const domains = new Set(activity.flatMap((a) => Object.keys((a.domains ?? {}) as object)));
    if (activity.length === 0 || active <= 0 || tracked <= 0 || !domains.has('127.0.0.1')) {
      throw new Error(`activity: ${JSON.stringify(activity)}`);
    }
    if (JSON.stringify(activity).includes('token=')) throw new Error('se guardó la query en urls');
    const shots = (await firestoreDocs('screenshots')).filter((s) => s.uid === uid);
    // One capture per 10-min block: a work day crossing a block boundary has two (or more).
    if (shots.length === 0 || shots.some((m) => m.blurred !== true || m.sessionId !== closed.id)) {
      throw new Error(`screenshots: ${JSON.stringify(shots)}`);
    }
    const files = await storageObjects(`screenshots/${uid}/`);
    const metas = await Promise.all(shots.map((m) => storageMeta(String(m.storagePath))));
    if (shots.some((m) => !files.includes(String(m.storagePath))) || metas.some((f) => f.contentType !== 'image/jpeg')) {
      throw new Error(`Storage: ${JSON.stringify(files)}`);
    }
    const file = metas[0]!;
    ok(
      `Jornada cerrada: ${Math.round((Number(closed.endedAt) - Number(closed.startedAt)) / 1000)} s, ${activity.length} bloque(s) ` +
        `(${active}/${tracked} s activos), ${shots.length === 1 ? `captura difuminada ${file.size} B` : `${shots.length} capturas difuminadas (${file.size} B la primera)`} en Storage; cola vacía.`,
    );

    // ---------- 3. Seeded web meeting (data as extension 0.1.2 writes it) ----------
    const meetingStart = slotStartOf(Number(closed.startedAt)) - 3 * SLOT_MS;
    if (meetingStart < startOfDay(zonedDate(Date.now()))) {
      throw new Error('faltan menos de 30 minutos desde la medianoche (hora de Chile): vuelve a ejecutar más tarde.');
    }
    const meetingBlocks = [
      { activeSeconds: 30, meetingSeconds: 540 }, // mostly meeting: 30 / (600 − 540) = 50 %
      { activeSeconds: 0, meetingSeconds: 600 }, // all meeting: no % ("—")
    ];
    const meetingSessionId = `e2e-reunion-${uid}`;
    const meetingEnd = meetingStart + meetingBlocks.length * SLOT_MS;
    await firestoreWrite(`sessions/${meetingSessionId}`, {
      uid,
      startedAt: meetingStart,
      endedAt: meetingEnd,
      endReason: 'manual',
      lastHeartbeatAt: meetingEnd,
    });
    for (const [i, b] of meetingBlocks.entries()) {
      const slotStart = meetingStart + i * SLOT_MS;
      await firestoreWrite(`activity/${activityDocId(uid, slotStart)}`, {
        uid,
        sessionId: meetingSessionId,
        slotStart,
        trackedSeconds: 600,
        ...b,
        outsideChromeSeconds: 0,
        domains: { 'meet.google.com': 600 },
        urls: [{ url: 'https://meet.google.com/abc-defg-hij', seconds: 600 }],
      });
    }
    const meetingTotal = formatDuration(meetingBlocks.reduce((n, b) => n + b.meetingSeconds, 0));
    ok(`Reunión web sembrada: ${meetingBlocks.length} bloques con meetingSeconds (${meetingTotal}) antes de la jornada medida.`);

    // ---------- 4. Admin sees the collaborator ----------
    await admin.bringToFront();
    await navTo(admin, 'Equipo');
    await admin.getByRole('button', { name: 'Actualizar' }).click();
    const table = admin.getByRole('table');
    const row = table.getByRole('row').filter({ hasText: COLLAB });
    await row.waitFor({ timeout: 15_000 });
    const hours = await until('horas > 0', async () => {
      const t = (await row.locator('td').nth(1).locator('.strong').textContent())?.trim() ?? '';
      return t && t !== '0 min' ? t : null;
    });
    const headers = (await table.locator('thead th').allTextContents()).map((h) => h.trim());
    const meetingCol = headers.indexOf('En reunión');
    if (meetingCol === -1) throw new Error(`la tabla del equipo no tiene la columna "En reunión": ${headers.join(' | ')}`);
    const meetingCell = await until('columna "En reunión"', async () => {
      const t = (await row.locator('td').nth(meetingCol).textContent())?.trim();
      return t === meetingTotal ? t : null;
    });
    ok(
      `Equipo: ${COLLAB_NAME} con ${hours} (${(await row.locator('.meter-value').textContent())?.trim()} de actividad, ` +
        `sin contar la reunión) y ${meetingCell} en reunión.`,
    );

    // Schedule columns: the same figures as the shared compliance functions with the saved schedule.
    const ownSessions: Session[] = (await firestoreDocs('sessions'))
      .filter((s) => s.uid === uid)
      .map((s) => ({
        uid,
        startedAt: Number(s.startedAt),
        endedAt: s.endedAt === null ? null : Number(s.endedAt),
        endReason: (s.endReason ?? null) as Session['endReason'],
        lastHeartbeatAt: Number(s.lastHeartbeatAt),
      }));
    const c = complianceForRange(today, today, ownSessions, schedule.week, schedule.holidays, schedule.toleranceMinutes, Date.now()).totals;
    // Entry an hour ago, first connection (the seeded meeting) ~30 min ago: late; everything after the entry.
    if (c.lateCount !== 1 || c.outsideScheduleSeconds !== 0 || c.inScheduleSeconds < 20 * 60) {
      throw new Error(`cumplimiento esperado inesperado: ${JSON.stringify(c)}`);
    }
    const col = (h: string): number => {
      const i = headers.indexOf(h);
      if (i === -1) throw new Error(`la tabla del equipo no tiene la columna "${h}": ${headers.join(' | ')}`);
      return i;
    };
    const cell = async (h: string): Promise<string> => ((await row.locator('td').nth(col(h)).textContent()) ?? '').trim();
    const expected = {
      'En horario': formatDuration(c.inScheduleSeconds),
      'Fuera de horario': formatDuration(c.outsideScheduleSeconds),
      Atrasos: `${c.lateCount}${formatDuration(c.lateSeconds)}`,
      Ausencias: '0',
    };
    for (const [h, want] of Object.entries(expected)) {
      const got = await cell(h);
      if (got !== want) throw new Error(`columna "${h}": "${got}" (esperado "${want}")`);
    }
    // Expected and offline hours grow with the clock: the table computed them when it loaded (±2 min).
    const minutesOf = (t: string): number => {
      const m = /^(?:(\d+) h)? ?(?:(\d+) min)?/.exec(t);
      return Number(m?.[1] ?? 0) * 60 + Number(m?.[2] ?? 0);
    };
    const expectedCell = await cell('Esperadas');
    const offlineCell = await cell('Sin conexión en horario');
    if (Math.abs(minutesOf(expectedCell) - Math.floor(c.expectedSoFarSeconds / 60)) > 2 || !expectedCell.includes(`de ${formatDuration(c.expectedSeconds)}`)) {
      throw new Error(`columna "Esperadas": "${expectedCell}" (esperado ~${formatDuration(c.expectedSoFarSeconds)} de ${formatDuration(c.expectedSeconds)})`);
    }
    if (Math.abs(minutesOf(offlineCell) - Math.floor(c.offlineSeconds / 60)) > 2) {
      throw new Error(`columna "Sin conexión en horario": "${offlineCell}" (esperado ~${formatDuration(c.offlineSeconds)})`);
    }
    ok(
      `Equipo con horario: esperadas ${formatDuration(c.expectedSoFarSeconds)} de ${formatDuration(c.expectedSeconds)}, en horario ${expected['En horario']}, fuera de horario ${expected['Fuera de horario']}, ` +
        `1 atraso de ${formatDuration(c.lateSeconds)}, sin conexión ${offlineCell}, 0 ausencias (igual que las funciones de shared).`,
    );

    await row.getByRole('link').click();
    await admin.getByRole('heading', { name: COLLAB_NAME }).waitFor();
    await admin.getByTestId('timeline-cell').first().waitFor();
    const daySchedule = ((await admin.getByTestId('day-schedule').textContent()) ?? '').trim();
    if (!daySchedule.includes('Horario general') || !daySchedule.includes('En curso')) throw new Error(`horario del día: "${daySchedule}"`);
    const cards = (await admin.getByRole('region', { name: 'Cumplimiento del día' }).textContent()) ?? '';
    for (const part of [`En horario${formatDuration(c.inScheduleSeconds)}`, `Atraso${formatDuration(c.lateSeconds)}`, 'Salida anticipada', 'Sin conexión en horario']) {
      if (!cards.includes(part)) throw new Error(`tarjetas de cumplimiento sin "${part}": ${cards}`);
    }
    // Entry mark (and the exit one at 23:59) on the timeline.
    const marks = await admin.locator('.cell .sch-mark').count();
    if (marks < 1) throw new Error('la línea de tiempo no marca la entrada');
    ok(`Detalle con horario: horario general del día y "En curso", tarjetas de cumplimiento (en horario ${formatDuration(c.inScheduleSeconds)}, atraso ${formatDuration(c.lateSeconds)}), ${marks} marca(s) de entrada/salida.`);
    const stats =(await admin.getByRole('region', { name: 'Resumen del día' }).textContent()) ?? '';
    if (!stats.includes(`En reunión${meetingTotal}`)) throw new Error(`tarjeta "En reunión": ${stats}`);
    const meetingCells = admin.locator('.cell.lvl-meeting');
    if ((await meetingCells.count()) !== meetingBlocks.length) throw new Error(`bloques "En reunión": ${await meetingCells.count()}`);
    const meetingTexts = (await meetingCells.allTextContents()).map((t) => t.trim());
    if (JSON.stringify(meetingTexts) !== JSON.stringify(['50', '—'])) throw new Error(`% de los bloques en reunión: ${JSON.stringify(meetingTexts)}`);
    await meetingCells.nth(1).hover();
    const meetingDetail = (await admin.getByTestId('timeline-detail').textContent()) ?? '';
    if (!meetingDetail.includes('En reunión10 min') || !meetingDetail.includes('Actividad: —')) throw new Error(`detalle del bloque en reunión: ${meetingDetail}`);
    ok(`Detalle: tarjeta "En reunión" ${meetingTotal}; bloques en reunión con su color, "50" y "—", y "En reunión 10 min" en el detalle.`);
    // The block measured by the extension (not a meeting).
    const measured = admin.locator('.cell:not(.lvl-none):not(.lvl-meeting)');
    const withData = await measured.count();
    if (withData === 0) throw new Error('la línea de tiempo no tiene bloques con datos');
    await measured.first().hover();
    const detail = (await admin.getByTestId('timeline-detail').textContent()) ?? '';
    if (!detail.includes('% de actividad') || !detail.includes('127.0.0.1')) throw new Error(`detalle del bloque: ${detail}`);
    const domainsCard = (await admin.locator('section', { has: admin.getByRole('heading', { name: 'Sitios más usados' }) }).textContent()) ?? '';
    if (!domainsCard.includes('127.0.0.1')) throw new Error(`sitios más usados: ${domainsCard}`);
    // As many thumbnails as captures (two when the work day crossed a 10-min block).
    const thumbs = admin.getByTestId('screenshot-thumb');
    // Thumbnails load when they enter the viewport (the day's schedule makes the page longer).
    await admin.getByRole('heading', { name: 'Capturas de pantalla' }).scrollIntoViewIfNeeded();
    await thumbs.first().waitFor({ timeout: 15_000 });
    await until(`${shots.length} miniatura(s)`, async () => ((await thumbs.count()) === shots.length ? true : null));
    await until('miniaturas cargadas', async () =>
      (await thumbs.evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)))
        ? true
        : null,
    );
    await admin.getByRole('button', { name: /Captura de las .* Ampliar/ }).first().click();
    const dialog = admin.getByRole('dialog');
    await dialog.waitFor();
    await until('imagen ampliada', () => admin.getByTestId('lightbox-img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0));
    if (!(await dialog.textContent())?.includes('Difuminada')) throw new Error('el lightbox no indica "Difuminada"');
    await admin.keyboard.press('Escape');
    ok(`Detalle: ${withData} bloque(s) con datos, 127.0.0.1 entre los sitios, ${shots.length} captura(s) visible(s) (miniatura + ampliada, "Difuminada").`);

    if (errors.length > 0) throw new Error(`errores en las páginas:\n${errors.join('\n')}`);
    console.log('E2E INTEGRADO OK: admin configura horario e invita → colaborador mide en horario en la extensión → admin ve horas, cumplimiento, actividad y captura.');
  } finally {
    // Close everything even if one step fails (no Chromium / Vite left behind on Windows).
    const closers: [string, () => Promise<unknown> | undefined][] = [
      ['extensión', () => ext?.close()],
      ['Chromium del portal', () => adminBrowser.close()],
      ['Vite', () => portal?.close()],
      ['sitio local', () => new Promise((r) => site.close(r))],
    ];
    for (const [what, close] of closers) {
      try {
        await close();
      } catch (err) {
        console.warn(`Aviso: no se pudo cerrar ${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

await main().catch((err: unknown) => {
  console.error(`E2E FALLÓ: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
process.exit(0);
