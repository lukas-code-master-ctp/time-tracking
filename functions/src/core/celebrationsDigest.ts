/**
 * Weekly birthdays and anniversaries email (spec
 * 2026-11-05-cumpleanos-aniversarios, `weeklyCelebrationsDigest`): every
 * Monday at 08:00 (America/Santiago) the active admins get the list of the
 * week, Monday to Sunday. Nothing is sent when the week has none.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  dayMonthLabel,
  readCelebration,
  upcomingCelebrations,
  yearsLabel,
  type Celebration,
  type UpcomingCelebration,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { deliverEmail, escapeHtml, type EmailMessage, type LoggerLike, type ResendConfig, type SendEmail } from './email.js';

const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function weekday(date: string): string {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
  return WEEKDAYS[d.getUTCDay()]!;
}

function addDays(date: string, days: number): string {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days));
  return d.toISOString().slice(0, 10);
}

/** "Cumpleaños" / "3 años en la empresa". */
function what(c: UpcomingCelebration): string {
  return c.kind === 'birthday' ? 'Cumpleaños' : `${yearsLabel(c.years ?? 0)} en la empresa`;
}

/**
 * The email for the week starting on `monday` (`YYYY-MM-DD`), or null when
 * the week has no celebrations. `managerName` gives the boss's name.
 */
export function buildCelebrationsDigest(params: {
  to: string[];
  monday: string;
  celebrations: readonly WithId<Celebration>[];
  managerName: (uid: string) => string | null;
  /** Link to the portal (optional: `PORTAL_URL`). */
  portalUrl: string | null;
}): EmailMessage | null {
  const { to, monday, celebrations, managerName, portalUrl } = params;
  const list = upcomingCelebrations(celebrations, monday, 6);
  if (list.length === 0) return null;
  const sunday = addDays(monday, 6);
  const range = `${dayMonthLabel(monday)} al ${dayMonthLabel(sunday)}`;
  const subject = `Cumpleaños y aniversarios de la semana (${range})`;
  const rows = list.map((c) => {
    const boss = c.managerUid ? managerName(c.managerUid) : null;
    return { day: `${weekday(c.date)} ${dayMonthLabel(c.date)}`, name: c.name, what: what(c), boss };
  });
  const text = [
    'Hola:',
    '',
    `Estos son los cumpleaños y aniversarios de la semana del ${range}:`,
    '',
    ...rows.map((r) => `- ${r.day}: ${r.name}, ${r.what.toLowerCase()}${r.boss ? ` (jefatura: ${r.boss})` : ''}`),
    '',
    portalUrl ? `Puedes revisar y editar las fechas en el portal: ${portalUrl}` : 'Puedes revisar y editar las fechas en el portal, en Colaboradores › Cumpleaños y aniversarios.',
  ].join('\n');
  const cell = 'padding: 6px 12px; border-bottom: 1px solid #e5e7eb; text-align: left;';
  const html = `<!doctype html>
<html lang="es">
<body style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.5;">
  <p>Hola:</p>
  <p>Estos son los cumpleaños y aniversarios de la semana del <strong>${escapeHtml(range)}</strong>:</p>
  <table style="border-collapse: collapse; font-size: 14px;">
    <thead><tr><th style="${cell}">Día</th><th style="${cell}">Persona</th><th style="${cell}">Qué celebra</th><th style="${cell}">Jefatura</th></tr></thead>
    <tbody>
${rows
  .map(
    (r) =>
      `      <tr><td style="${cell}">${escapeHtml(r.day)}</td><td style="${cell}"><strong>${escapeHtml(r.name)}</strong></td><td style="${cell}">${escapeHtml(r.what)}</td><td style="${cell}">${escapeHtml(r.boss ?? '—')}</td></tr>`,
  )
  .join('\n')}
    </tbody>
  </table>
  <p>${portalUrl ? `Puedes revisar y editar las fechas en el <a href="${escapeHtml(portalUrl)}">portal</a>.` : 'Puedes revisar y editar las fechas en el portal, en Colaboradores › Cumpleaños y aniversarios.'}</p>
</body>
</html>`;
  return { to, subject, text, html };
}

export interface DigestDeps {
  db: Firestore;
  /** `YYYY-MM-DD` of the Monday (America/Santiago). */
  monday: string;
  portalUrl: string | null;
  config: ResendConfig | null;
  isEmulator: boolean;
  emailEnabled: boolean;
  send: SendEmail;
  logger: LoggerLike;
}

/** Reads the people and their dates, and sends one email to every active admin. */
export async function sendCelebrationsDigestCore(deps: DigestDeps): Promise<{ sent: boolean; items: number; recipients: number }> {
  const [usersSnap, celebrationsSnap] = await Promise.all([
    deps.db.collection(COLLECTIONS.users).get(),
    deps.db.collection(COLLECTIONS.celebrations).get(),
  ]);
  const users = new Map(usersSnap.docs.map((d) => [d.id, d.data() as UserProfile]));
  const celebrations: WithId<Celebration>[] = [];
  for (const d of celebrationsSnap.docs) {
    const c = readCelebration(d.data());
    // Disabled in `users` too (the copy could be stale).
    if (c && users.get(d.id)?.status === 'active') celebrations.push({ ...c, id: d.id });
  }
  const to = [...users.values()]
    .filter((u) => u.role === 'admin' && u.status === 'active' && typeof u.email === 'string' && u.email)
    .map((u) => u.email);
  const managerName = (uid: string): string | null => {
    const u = users.get(uid);
    return u ? u.displayName || u.email : null;
  };
  const message = buildCelebrationsDigest({ to, monday: deps.monday, celebrations, managerName, portalUrl: deps.portalUrl });
  if (!message) {
    deps.logger.info('Resumen semanal de cumpleaños: no hay fechas esta semana, no se envía');
    return { sent: false, items: 0, recipients: to.length };
  }
  if (to.length === 0) {
    deps.logger.warn('Resumen semanal de cumpleaños: no hay administradores activos');
    return { sent: false, items: 0, recipients: 0 };
  }
  const result = await deliverEmail({
    label: 'Resumen semanal de cumpleaños',
    message,
    config: deps.config,
    isEmulator: deps.isEmulator,
    emailEnabled: deps.emailEnabled,
    send: deps.send,
    logger: deps.logger,
  });
  return { sent: result === 'sent', items: upcomingCelebrations(celebrations, deps.monday, 6).length, recipients: to.length };
}
