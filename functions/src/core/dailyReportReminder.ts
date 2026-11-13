/**
 * Reminder email of the daily report (spec 2026-11-13-minuta-terreno,
 * `dailyReportReminders`): people in the field have no computer, so nothing
 * reminds them when they close the day. Every 15 minutes the job looks for
 * the people asked for the report (in the field, or in the chosen groups) whose schedule ended in the last hours,
 * who did not send today's report yet, and emails each one the link to the
 * phone page (`/terreno`). Once per person and day
 * (`dailyReportReminders/{uid_date}`).
 */
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  DEFAULT_TIME_ZONE,
  ORG_CONFIG_DOC_ID,
  SCHEDULE_CONFIG_DOC_ID,
  dailyReportDocId,
  dailyReportReminderDue,
  dateKey,
  effectiveWeek,
  membersOf,
  readDailyReportSettings,
  readGroup,
  readPersonSchedule,
  readScheduleConfig,
  type Absence,
  type DailyReportReminder,
  type OrgConfig,
  type PersonGroup,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { deliverEmail, escapeHtml, type EmailMessage, type LoggerLike, type ResendConfig, type SendEmail } from './email.js';

/** The reminder of one person. */
export function buildDailyReportReminder(params: { to: string; name: string | null; link: string }): EmailMessage {
  const hello = params.name ? `Hola, ${params.name.split(' ')[0]}:` : 'Hola:';
  const subject = 'Envía tu minuta del día';
  const text = [
    hello,
    '',
    'Terminó tu jornada. Cuéntanos cómo estuvo tu día: graba un audio corto desde el celular y la minuta se arma sola, o escríbela.',
    '',
    `Envíala aquí: ${params.link}`,
    '',
    'Si hoy no trabajaste, ignora este correo.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="es">
<body style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.5;">
  <p>${escapeHtml(hello)}</p>
  <p>Terminó tu jornada. Cuéntanos cómo estuvo tu día: graba un audio corto desde el celular y la minuta se arma sola, o escríbela.</p>
  <p><a href="${escapeHtml(params.link)}" style="display: inline-block; background: #26336b; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">Enviar mi minuta</a></p>
  <p style="color: #6b7280; font-size: 13px;">Si hoy no trabajaste, ignora este correo.</p>
</body>
</html>`;
  return { to: params.to, subject, text, html };
}

export interface ReminderDeps {
  db: Firestore;
  now: number;
  /** Link of the phone page, e.g. `https://app.mipegahr.cl/terreno`. */
  link: string;
  config: ResendConfig | null;
  isEmulator: boolean;
  emailEnabled: boolean;
  send: SendEmail;
  logger: LoggerLike;
}

export interface ReminderResult {
  /** People asked for the report. */
  asked: number;
  /** Emails sent (or logged when email is off). */
  reminded: string[];
}

export async function sendDailyReportRemindersCore(deps: ReminderDeps): Promise<ReminderResult> {
  const { db, now } = deps;
  const orgSnap = await db.collection(COLLECTIONS.config).doc(ORG_CONFIG_DOC_ID).get();
  const settings = readDailyReportSettings(orgSnap.data() as OrgConfig | undefined);
  if (!settings.enabled) return { asked: 0, reminded: [] };

  // People in the field, plus the members of the chosen groups.
  const groups: WithId<PersonGroup>[] = [];
  if (settings.groupIds.length > 0) {
    const groupRefs = settings.groupIds.map((id) => db.collection(COLLECTIONS.groups).doc(id));
    for (const snap of await db.getAll(...groupRefs)) {
      const g = snap.exists ? readGroup(snap.data()) : null;
      if (g) groups.push({ ...g, id: snap.id });
    }
  }
  const field = await db.collection(COLLECTIONS.users).where('workplace', '==', 'field').get();
  const uids = [...new Set([...field.docs.map((d) => d.id), ...membersOf(groups, settings.groupIds)])];
  if (uids.length === 0) return { asked: 0, reminded: [] };

  const date = dateKey(now, DEFAULT_TIME_ZONE);
  const many = (name: string, ids: string[]): Promise<DocumentSnapshot[]> =>
    db.getAll(...ids.map((id) => db.collection(name).doc(id)));
  const dayIds = uids.map((uid) => dailyReportDocId(uid, date));
  const [userSnaps, scheduleSnaps, reportSnaps, reminderSnaps, orgSchedule, absenceSnap] = await Promise.all([
    many(COLLECTIONS.users, uids),
    many(COLLECTIONS.schedules, uids),
    many(COLLECTIONS.dailyReports, dayIds),
    many(COLLECTIONS.dailyReportReminders, dayIds),
    db.collection(COLLECTIONS.config).doc(SCHEDULE_CONFIG_DOC_ID).get(),
    // Absences that end today or later; the start is checked below.
    db.collection(COLLECTIONS.absences).where('endDate', '>=', date).get(),
  ]);
  const general = readScheduleConfig(orgSchedule.data());
  const absences = new Map<string, Absence[]>();
  for (const d of absenceSnap.docs) {
    const a = d.data() as Absence;
    if (typeof a.uid !== 'string') continue;
    absences.set(a.uid, [...(absences.get(a.uid) ?? []), a]);
  }

  const reminded: string[] = [];
  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i]!;
    const user = userSnaps[i]!.data() as UserProfile | undefined;
    if (!user || user.status !== 'active' || typeof user.email !== 'string' || !user.email) continue;
    const week = effectiveWeek(general, readPersonSchedule(scheduleSnaps[i]!.data()));
    const due = dailyReportReminderDue({
      now,
      date,
      week,
      holidays: general?.holidays ?? [],
      absences: absences.get(uid) ?? [],
      sent: reportSnaps[i]!.exists,
      reminded: reminderSnaps[i]!.exists,
    });
    if (!due) continue;
    // Marked before sending: a failure costs one reminder, never a duplicate.
    const mark: DailyReportReminder = { uid, date, sentAt: now };
    await db.collection(COLLECTIONS.dailyReportReminders).doc(dayIds[i]!).set(mark);
    try {
      await deliverEmail({
        label: 'Recordatorio de minuta',
        message: buildDailyReportReminder({ to: user.email, name: user.displayName || null, link: deps.link }),
        config: deps.config,
        isEmulator: deps.isEmulator,
        emailEnabled: deps.emailEnabled,
        send: deps.send,
        logger: deps.logger,
      });
      reminded.push(uid);
    } catch (err) {
      deps.logger.warn('Recordatorio de minuta: no se pudo enviar', { uid, error: String(err) });
    }
  }
  return { asked: uids.length, reminded };
}
