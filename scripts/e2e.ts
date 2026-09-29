/**
 * Integrated end-to-end test: portal (admin) + extension (collaborator)
 * against the Firebase emulators, in the real order of use.
 *
 *   npm run e2e   (root: builds functions and the dev extension, then runs this
 *   inside firebase emulators:exec --only auth,firestore,functions,storage)
 *
 * 1. Admin, in the portal (UI): dev login as the bootstrap admin → turns on
 *    blurred screenshots in Configuración → invites the collaborator in
 *    Invitaciones (placeholder install link warning visible).
 * 2. Collaborator, in the extension (Chromium with dist-dev): dev login with
 *    the invited e-mail → joinOrg (member, invitation accepted) → notice →
 *    starts the work day → real keyboard/mouse activity on a local page for
 *    ~70 s → forced pulse + forced capture → closes the work day → queue empty.
 * 3. Admin, in the portal: the collaborator appears with hours > 0; the detail
 *    shows the timeline with data, the local site among the domains and the
 *    screenshot (thumbnail + lightbox "Difuminada").
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { CONSENT_VERSION } from '@timetracking/shared';
import { EXTENSION_DEV_DIR, launchExtension, sendFrom, startPortal, type ExtensionBrowser } from './lib/browser.ts';
import { chromiumPath } from './lib/chromium.ts';
import {
  ADMIN_EMAIL,
  assertEmulators,
  clearEmulators,
  firestoreDoc,
  firestoreDocs,
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

    await navTo(admin, 'Invitaciones');
    await admin.getByTestId('install-url-warning').waitFor();
    await admin.getByLabel('Correo de la persona').fill(COLLAB);
    await admin.getByRole('button', { name: 'Invitar' }).click();
    await admin.getByText(`Invitación enviada a ${COLLAB}.`).waitFor();
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
    await popup.getByPlaceholder('correo@compratuparcela.cl').fill(COLLAB);
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
    ok('Jornada iniciada.');

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
    const meta = shots[0];
    if (!meta || meta.blurred !== true || meta.sessionId !== closed.id) throw new Error(`screenshots: ${JSON.stringify(shots)}`);
    const files = await storageObjects(`screenshots/${uid}/`);
    const file = await storageMeta(String(meta.storagePath));
    if (!files.includes(String(meta.storagePath)) || file.contentType !== 'image/jpeg') throw new Error(`Storage: ${JSON.stringify(files)}`);
    ok(
      `Jornada cerrada: ${Math.round((Number(closed.endedAt) - Number(closed.startedAt)) / 1000)} s, ${activity.length} bloque(s) ` +
        `(${active}/${tracked} s activos), captura difuminada ${file.size} B en Storage; cola vacía.`,
    );

    // ---------- 3. Admin sees the collaborator ----------
    await admin.bringToFront();
    await navTo(admin, 'Equipo');
    await admin.getByRole('button', { name: 'Actualizar' }).click();
    const row = admin.getByRole('table').getByRole('row').filter({ hasText: COLLAB });
    await row.waitFor({ timeout: 15_000 });
    const hours = await until('horas > 0', async () => {
      const t = (await row.locator('td').nth(1).locator('.strong').textContent())?.trim() ?? '';
      return t && t !== '0 min' ? t : null;
    });
    ok(`Equipo: ${COLLAB_NAME} con ${hours} (${(await row.locator('.meter-value').textContent())?.trim()} de actividad).`);

    await row.getByRole('link').click();
    await admin.getByRole('heading', { name: COLLAB_NAME }).waitFor();
    await admin.getByTestId('timeline-cell').first().waitFor();
    const withData = await admin.locator('.cell:not(.lvl-none)').count();
    if (withData === 0) throw new Error('la línea de tiempo no tiene bloques con datos');
    await admin.locator('.cell:not(.lvl-none)').first().hover();
    const detail = (await admin.getByTestId('timeline-detail').textContent()) ?? '';
    if (!detail.includes('% de actividad') || !detail.includes('127.0.0.1')) throw new Error(`detalle del bloque: ${detail}`);
    const domainsCard = (await admin.locator('section', { has: admin.getByRole('heading', { name: 'Sitios más usados' }) }).textContent()) ?? '';
    if (!domainsCard.includes('127.0.0.1')) throw new Error(`sitios más usados: ${domainsCard}`);
    const thumb = admin.getByTestId('screenshot-thumb');
    await thumb.waitFor({ timeout: 15_000 });
    await until('miniatura cargada', () => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0));
    await admin.getByRole('button', { name: /Captura de las .* Ampliar/ }).click();
    const dialog = admin.getByRole('dialog');
    await dialog.waitFor();
    await until('imagen ampliada', () => admin.getByTestId('lightbox-img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0));
    if (!(await dialog.textContent())?.includes('Difuminada')) throw new Error('el lightbox no indica "Difuminada"');
    await admin.keyboard.press('Escape');
    ok(`Detalle: ${withData} bloque(s) con datos, 127.0.0.1 entre los sitios, captura visible (miniatura + ampliada, "Difuminada").`);

    if (errors.length > 0) throw new Error(`errores en las páginas:\n${errors.join('\n')}`);
    console.log('E2E INTEGRADO OK: admin invita → colaborador mide en la extensión → admin ve horas, actividad y captura.');
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
