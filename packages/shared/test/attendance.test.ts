import { describe, expect, it } from 'vitest';
import {
  attendanceDays,
  attendanceModeOf,
  forgottenExitEnd,
  formatRut,
  formatRutInput,
  normalizeRut,
  readAttendanceSettings,
  rutCheckDigit,
} from '../src/attendance.js';
import { MAX_SESSION_MS } from '../src/config.js';
import { complianceForDay, zonedDateTimeToMs } from '../src/schedule.js';
import { isSessionLive, sessionEndAt } from '../src/sessions.js';
import { sessionDurationSeconds } from '../src/reports.js';
import type { Session, WeekSchedule } from '../src/types.js';

const MIN = 60_000;
const at = (date: string, time: string): number => zonedDateTimeToMs(date, time);

function s(partial: Partial<Session> & Pick<Session, 'startedAt'>): Session {
  return { uid: 'u1', endedAt: null, endReason: null, lastHeartbeatAt: partial.startedAt, ...partial };
}

const DAY = { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' };
const WEEK: WeekSchedule = { mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: null, sun: null };

describe('RUT', () => {
  it('computes the check digit', () => {
    expect(rutCheckDigit('12345678')).toBe('5');
    expect(rutCheckDigit('11111111')).toBe('1');
    expect(rutCheckDigit('10000013')).toBe('K');
    expect(rutCheckDigit('7654321')).toBe('6');
  });

  it('normalizes the usual spellings and rejects a wrong check digit', () => {
    expect(normalizeRut('12.345.678-5')).toBe('12345678-5');
    expect(normalizeRut(' 123456785 ')).toBe('12345678-5');
    expect(normalizeRut('10.000.013-k')).toBe('10000013-K');
    expect(normalizeRut('012345678-5')).toBe('12345678-5');
    expect(normalizeRut('12.345.678-4')).toBeNull();
    expect(normalizeRut('abc')).toBeNull();
    expect(normalizeRut('')).toBeNull();
    expect(normalizeRut(12345678)).toBeNull();
    expect(normalizeRut('123456789-0')).toBeNull();
  });

  it('formats', () => {
    expect(formatRut('12345678-5')).toBe('12.345.678-5');
    expect(formatRut('7654321-6')).toBe('7.654.321-6');
    expect(formatRutInput('123456785')).toBe('12.345.678-5');
    expect(formatRutInput('1')).toBe('1');
    expect(formatRutInput('10000013k')).toBe('10.000.013-K');
  });
});

describe('attendance settings', () => {
  it('reads valid documents and defaults to the extension', () => {
    const ok = { rut: '12345678-5', mode: 'kiosk', updatedAt: 1, updatedBy: 'a' };
    expect(readAttendanceSettings(ok)).toEqual(ok);
    expect(readAttendanceSettings({ ...ok, rut: '12.345.678-5' })).toBeNull();
    expect(readAttendanceSettings({ ...ok, mode: 'x' })).toBeNull();
    expect(attendanceModeOf(ok)).toBe('kiosk');
    expect(attendanceModeOf(null)).toBe('extension');
  });
});

describe('kiosk sessions', () => {
  const start = at('2026-11-10', '09:00');

  it('an open kiosk session lasts until now and stays live without heartbeat', () => {
    const k = s({ startedAt: start, source: 'kiosk' });
    expect(sessionEndAt(k, start + 120 * MIN)).toBe(start + 120 * MIN);
    expect(isSessionLive(k, start + 120 * MIN)).toBe(true);
    expect(isSessionLive(k, start + MAX_SESSION_MS + 1)).toBe(false);
    expect(sessionDurationSeconds(k, undefined, undefined, start + 60 * MIN)).toBe(3600);
    // Without `now` (older callers) it is its last heartbeat, as before.
    expect(sessionEndAt(k)).toBe(start);
  });

  it('extension sessions are unchanged', () => {
    const e = s({ startedAt: start, lastHeartbeatAt: start + 10 * MIN });
    expect(sessionEndAt(e, start + 120 * MIN)).toBe(start + 10 * MIN);
    expect(isSessionLive(e, start + 41 * MIN)).toBe(false);
  });

  it('counts for the compliance', () => {
    const k = s({ startedAt: start, source: 'kiosk' });
    const c = complianceForDay('2026-11-10', [k], WEEK, [], 5, at('2026-11-10', '12:00'));
    expect(c.lateSeconds).toBe(0);
    expect(c.inScheduleSeconds).toBe(3 * 3600);
  });

  it('a forgotten exit ends at the end of the schedule, or at the entry without one', () => {
    expect(forgottenExitEnd({ startedAt: start }, WEEK, [])).toBe(at('2026-11-10', '18:30'));
    expect(forgottenExitEnd({ startedAt: at('2026-11-10', '19:00') }, WEEK, [])).toBe(at('2026-11-10', '19:00'));
    expect(forgottenExitEnd({ startedAt: at('2026-11-14', '10:00') }, WEEK, [])).toBe(at('2026-11-14', '10:00'));
    expect(forgottenExitEnd({ startedAt: start }, null, [])).toBe(start);
  });
});

describe('attendanceDays', () => {
  it('groups by person and day: first entry, last exit, sources and worked time', () => {
    const d = '2026-11-10';
    const rows = attendanceDays(
      [
        { ...s({ startedAt: at(d, '09:02'), source: 'kiosk', endedAt: at(d, '13:00'), endReason: 'manual', kioskId: 'k' }), id: 'first' },
        // The extension splits a work day at a sleep gap.
        s({ startedAt: at(d, '14:00'), lastHeartbeatAt: at(d, '16:00'), endedAt: at(d, '16:00'), endReason: 'manual' }),
        { ...s({ startedAt: at(d, '16:10'), lastHeartbeatAt: at(d, '18:00'), endedAt: at(d, '18:31'), endReason: 'manual', closedByKioskId: 'k' }), id: 'last' },
        s({ uid: 'u2', startedAt: at(d, '08:55'), lastHeartbeatAt: at(d, '10:00') }),
        s({ uid: 'u2', startedAt: at('2026-11-09', '09:00'), endedAt: at('2026-11-09', '09:00'), endReason: 'auto', source: 'kiosk' }),
      ],
      at(d, '19:00'),
    );
    expect(rows.map((r) => [r.uid, r.date])).toEqual([
      ['u2', d],
      ['u1', d],
      ['u2', '2026-11-09'],
    ]);
    const u1 = rows[1]!;
    expect(u1).toMatchObject({ inSource: 'kiosk', outSource: 'kiosk', open: false, sessionCount: 3, lastOut: at(d, '18:31') });
    // Sessions of the first entry and last exit (kiosk photos).
    expect(u1).toMatchObject({ firstInSessionId: 'first', lastOutSessionId: 'last' });
    expect(u1.workedSeconds).toBe((238 + 120 + 141) * 60);
    expect(rows[0]).toMatchObject({ open: true, lastOut: null, outSource: null, inSource: 'extension', lastOutSessionId: null });
    expect(rows[2]).toMatchObject({ outSource: 'auto', workedSeconds: 0 });
  });
});
