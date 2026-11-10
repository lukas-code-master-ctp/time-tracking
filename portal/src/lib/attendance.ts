/**
 * Portal side of the attendance marks (spec 2026-11-10-marcaciones): the
 * "Marcaciones" table and its CSV, the RUT/mode form and the kiosk links.
 */
import {
  ATTENDANCE_MODE_LABELS,
  allowsKiosk,
  normalizeRut,
  toCsv,
  type AttendanceDay,
  type AttendanceMode,
  type AttendanceSettings,
  type ExitSource,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { formatTime } from './dates';

export const KIOSK_PATH = '/marcar';

/** Random secret of a kiosk (32 bytes, base64url: 43 characters). */
export function newKioskToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 (hex) of the token: the id of `kiosks/{id}` (same as `kioskIdOf` in functions). */
export async function kioskIdOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Link that activates a device as kiosk (the token travels in the `#`, never to a server). */
export function kioskUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}${KIOSK_PATH}#${token}`;
}

export interface AttendanceForm {
  rut: string;
  mode: AttendanceMode;
}

/** Problem of the form, or null. `others`: the normalized RUTs of the other people. */
export function attendanceFormError(form: AttendanceForm, others: ReadonlySet<string>): string | null {
  const raw = form.rut.trim();
  const rut = raw ? normalizeRut(raw) : null;
  if (raw && !rut) return 'El RUT no es válido: revisa el dígito verificador.';
  if (!rut && allowsKiosk(form.mode)) return 'Para marcar en el tótem la persona necesita un RUT.';
  if (rut && others.has(rut)) return 'Ese RUT ya está registrado para otra persona.';
  return null;
}

export function buildAttendanceSettings(form: AttendanceForm, adminUid: string, now: number): AttendanceSettings {
  const raw = form.rut.trim();
  return { rut: raw ? normalizeRut(raw) : null, mode: form.mode, updatedAt: now, updatedBy: adminUid };
}

export const SOURCE_LABEL: Record<ExitSource, string> = {
  extension: 'Extensión',
  kiosk: 'Tótem',
  auto: 'Automática',
};

/** "Salida" cell: time, or what happened instead. */
export function exitLabel(row: AttendanceDay, timeZone?: string): string {
  if (row.open) return 'En curso';
  if (row.outSource === 'auto') return row.workedSeconds === 0 ? 'Sin salida' : `${formatTime(row.lastOut!, timeZone)} (automática)`;
  return formatTime(row.lastOut!, timeZone);
}

export function attendanceCsv(
  rows: readonly AttendanceDay[],
  users: ReadonlyMap<string, Pick<UserProfile, 'displayName' | 'email'>>,
  settings: ReadonlyMap<string, Pick<AttendanceSettings, 'rut'>>,
  timeZone?: string,
): string {
  return toCsv(
    rows.map((r) => {
      const u = users.get(r.uid);
      return {
        date: r.date,
        name: u?.displayName || u?.email || r.uid,
        email: u?.email ?? '',
        rut: settings.get(r.uid)?.rut ?? '',
        in: formatTime(r.firstIn, timeZone),
        inSource: SOURCE_LABEL[r.inSource],
        out: r.open ? '' : r.outSource === 'auto' && r.workedSeconds === 0 ? '' : formatTime(r.lastOut!, timeZone),
        outSource: r.open ? 'En curso' : r.outSource ? SOURCE_LABEL[r.outSource] : '',
        hours: Math.round(r.workedSeconds / 36) / 100,
      };
    }),
    [
      { key: 'date', header: 'Fecha' },
      { key: 'name', header: 'Nombre' },
      { key: 'email', header: 'Correo' },
      { key: 'rut', header: 'RUT' },
      { key: 'in', header: 'Entrada' },
      { key: 'inSource', header: 'Marcó entrada en' },
      { key: 'out', header: 'Salida' },
      { key: 'outSource', header: 'Marcó salida en' },
      { key: 'hours', header: 'Horas en jornada' },
    ],
    { separator: ';', decimalSeparator: ',', bom: true },
  );
}

export { ATTENDANCE_MODE_LABELS };
export type AttendanceUser = WithId<UserProfile>;
