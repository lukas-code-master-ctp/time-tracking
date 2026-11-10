/**
 * Attendance marks ("Marcaciones", spec 2026-11-10-marcaciones): each person
 * opens and closes the work day from the extension button, from the kiosk at
 * the office entrance (typing their RUT) or both, as an admin decides
 * (`attendanceSettings/{uid}`). Both open the same kind of `sessions` doc, so
 * hours, late arrivals and the timeline work the same. Pure.
 */
import { DEFAULT_TIME_ZONE, dateKey } from './collections.js';
import { MAX_SESSION_MS } from './config.js';
import { mergeIntervals, planForDay } from './schedule.js';
import { sessionEndAt } from './sessions.js';
import type { AttendanceMode, AttendanceSettings, Kiosk, Session, SessionSource, WeekSchedule } from './types.js';

export const ATTENDANCE_MODES: readonly AttendanceMode[] = ['extension', 'kiosk', 'both'];

export const ATTENDANCE_MODE_LABELS: Record<AttendanceMode, string> = {
  extension: 'Extensión',
  kiosk: 'Tótem',
  both: 'Extensión y tótem',
};

export function isAttendanceMode(value: unknown): value is AttendanceMode {
  return typeof value === 'string' && (ATTENDANCE_MODES as readonly string[]).includes(value);
}

/** The person can open the work day from the extension button. */
export function allowsExtension(mode: AttendanceMode): boolean {
  return mode !== 'kiosk';
}

/** The person can mark entry and exit on the kiosk. */
export function allowsKiosk(mode: AttendanceMode): boolean {
  return mode !== 'extension';
}

// ---------- RUT ----------

/** Normalized RUT: body without dots or leading zeros, dash, check digit (uppercase K). */
export const RUT_RE = /^[1-9]\d{0,7}-[0-9K]$/;

/** Check digit (módulo 11) of the RUT body (digits only). */
export function rutCheckDigit(body: string): string {
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - (sum % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}

/**
 * `12.345.678-5`, `12345678-5`, `123456785`, `12345678 5`… → `12345678-5`;
 * null when it is not a RUT or the check digit is wrong.
 */
export function normalizeRut(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const clean = input.replace(/[.\s-]/g, '').toUpperCase();
  if (!/^\d{1,9}[0-9K]$/.test(clean)) return null;
  const body = clean.slice(0, -1).replace(/^0+/, '');
  const dv = clean.slice(-1);
  if (!body || body.length > 8) return null;
  if (rutCheckDigit(body) !== dv) return null;
  return `${body}-${dv}`;
}

/** `12345678-5` → `12.345.678-5` (anything else is returned as is). */
export function formatRut(rut: string): string {
  const m = /^(\d+)-([0-9K])$/.exec(rut);
  if (!m) return rut;
  return `${m[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${m[2]}`;
}

/**
 * Formats what is being typed on the kiosk: digits and K, the last one as
 * check digit (`123456785` → `12.345.678-5`). At most 9 characters.
 */
export function formatRutInput(raw: string): string {
  const clean = raw.replace(/[^0-9kK]/g, '').toUpperCase().slice(0, 9);
  if (clean.length < 2) return clean;
  return formatRut(`${clean.slice(0, -1)}-${clean.slice(-1)}`);
}

// ---------- documents ----------

/** Valid `attendanceSettings/{uid}`, or null. */
export function readAttendanceSettings(raw: unknown): AttendanceSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (!isAttendanceMode(d.mode)) return null;
  if (d.rut !== null && !(typeof d.rut === 'string' && RUT_RE.test(d.rut))) return null;
  if (typeof d.updatedAt !== 'number' || typeof d.updatedBy !== 'string') return null;
  return { rut: d.rut, mode: d.mode, updatedAt: d.updatedAt, updatedBy: d.updatedBy };
}

/** Mode of a raw `attendanceSettings/{uid}` (missing or invalid: `'extension'`, as before the kiosk). */
export function attendanceModeOf(raw: unknown): AttendanceMode {
  return readAttendanceSettings(raw)?.mode ?? 'extension';
}

export const KIOSK_NAME_MAX = 60;

/** Valid `kiosks/{id}`, or null. */
export function readKiosk(raw: unknown): Kiosk | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.name !== 'string' || typeof d.createdAt !== 'number' || typeof d.createdBy !== 'string') return null;
  if (d.revokedAt !== null && typeof d.revokedAt !== 'number') return null;
  const lastUsedAt = typeof d.lastUsedAt === 'number' ? d.lastUsedAt : null;
  return { name: d.name, createdAt: d.createdAt, createdBy: d.createdBy, revokedAt: d.revokedAt, lastUsedAt };
}

/** Kiosk token ids are the SHA-256 of the token, in hex. */
export const KIOSK_ID_RE = /^[0-9a-f]{64}$/;

// ---------- forgotten exit ----------

/**
 * End of a kiosk work day whose exit was never marked: the end of that day's
 * schedule when it falls after the entry (within MAX_SESSION_MS); without a
 * schedule for that day, the entry itself (0 hours, so a forgotten exit does
 * not invent hours; the table shows "Sin salida").
 */
export function forgottenExitEnd(
  session: Pick<Session, 'startedAt'>,
  week: WeekSchedule | null,
  holidays: readonly string[],
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const plan = planForDay(dateKey(session.startedAt, timeZone), week, holidays, timeZone);
  const end = plan.span?.end;
  if (end !== undefined && end > session.startedAt && end <= session.startedAt + MAX_SESSION_MS) return end;
  return session.startedAt;
}

// ---------- the "Marcaciones" table ----------

/** How the work day was closed: on the kiosk, from the extension, or automatically. */
export type ExitSource = SessionSource | 'auto';

/** One row of the table: a person on a day (by the day of each entry). */
export interface AttendanceDay {
  uid: string;
  /** `YYYY-MM-DD` of the first entry. */
  date: string;
  firstIn: number;
  inSource: SessionSource;
  /** End of the last work day of the day; null while one is open. */
  lastOut: number | null;
  outSource: ExitSource | null;
  /** A work day of this day is still open. */
  open: boolean;
  /** Connected seconds of the day's work days (overlaps once; open ones until now). */
  workedSeconds: number;
  /** Number of work days ("jornadas") of the day: the extension splits one at a sleep gap. */
  sessionCount: number;
}

function exitSource(s: Session): ExitSource | null {
  if (s.endedAt === null) return null;
  if (s.closedByKioskId) return 'kiosk';
  if (s.endReason === 'auto') return 'auto';
  return s.source ?? 'extension';
}

/**
 * Rows of the "Marcaciones" table, newest day first and then by first entry.
 * Each session belongs to the day of its start (America/Santiago).
 */
export function attendanceDays(
  sessions: readonly Session[],
  now: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): AttendanceDay[] {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = `${s.uid}\u0000${dateKey(s.startedAt, timeZone)}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const rows: AttendanceDay[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.startedAt - b.startedAt);
    const first = list[0]!;
    const open = list.some((s) => s.endedAt === null);
    let last = list[0]!;
    for (const s of list) if (s.endedAt !== null && s.endedAt >= (last.endedAt ?? -1)) last = s;
    const pieces = mergeIntervals(
      list.map((s) => ({ start: s.startedAt, end: Math.min(sessionEndAt(s, now), now) })).filter((p) => p.end > p.start),
    );
    const worked = pieces.reduce((t, p) => t + (p.end - p.start), 0);
    rows.push({
      uid: first.uid,
      date: key.slice(key.indexOf('\u0000') + 1),
      firstIn: first.startedAt,
      inSource: first.source ?? 'extension',
      lastOut: open ? null : last.endedAt,
      outSource: open ? null : exitSource(last),
      open,
      workedSeconds: Math.floor(worked / 1000),
      sessionCount: list.length,
    });
  }
  return rows.sort((a, b) => (a.date === b.date ? a.firstIn - b.firstIn : a.date < b.date ? 1 : -1));
}
