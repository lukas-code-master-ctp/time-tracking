import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { zonedDateTimeToMs, type Session } from '@timetracking/shared';
import { decodeKioskPhoto, kioskIdOf, kioskPunchCore, type PhotoBucket } from '../../src/core/kiosk.js';
import { decideAutoClose } from '../../src/core/autoClose.js';
import { clearFirestore, closeAdmin, db, getDoc, seed } from './helpers.js';

const TOKEN = 'k'.repeat(43);
const KIOSK = kioskIdOf(TOKEN);
const at = (date: string, time: string): number => zonedDateTimeToMs(date, time);
const T = at('2026-11-10', '09:02');
const DAY = { start: '09:00', end: '18:30', lunchStart: null, lunchEnd: null };

const user = (name: string, status = 'active') => ({
  email: `${name.toLowerCase()}@impulseai.cl`,
  displayName: `${name} Pérez`,
  photoURL: null,
  role: 'member',
  status,
  createdAt: 1,
});
const settings = (rut: string | null, mode = 'kiosk') => ({ rut, mode, updatedAt: 1, updatedBy: 'admin' });

async function sessionsOf(uid: string): Promise<Session[]> {
  const snap = await db().collection('sessions').where('uid', '==', uid).get();
  return snap.docs.map((d) => d.data() as Session).sort((a, b) => a.startedAt - b.startedAt);
}

async function rejection(p: Promise<unknown>): Promise<{ reason?: string; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { details?: { reason?: string }; message: string };
    return { reason: e.details?.reason, message: e.message };
  }
  throw new Error('expected a rejection');
}

beforeEach(async () => {
  await clearFirestore();
  await seed({
    [`kiosks/${KIOSK}`]: { name: 'Recepción', createdAt: 1, createdBy: 'admin', revokedAt: null },
    'users/ana': user('Ana'),
    'attendanceSettings/ana': settings('12345678-5'),
    'users/beto': user('Beto'),
    'attendanceSettings/beto': settings('7654321-6', 'extension'),
    'users/dani': user('Dani', 'disabled'),
    'attendanceSettings/dani': settings('11111111-1'),
    'config/schedule': {
      week: { mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: null, sun: null },
      holidays: [],
      toleranceMinutes: 5,
      remindersEnabled: true,
      updatedAt: 1,
      updatedBy: 'admin',
    },
  });
});

afterAll(async () => {
  await closeAdmin();
});

const punch = (rut: string, action: 'in' | 'out', now = T, token = TOKEN) =>
  kioskPunchCore({ db: db(), now }, { token, rut, action });

/** A tiny JPEG (only the magic number matters to the core). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');

function fakeBucket(fail = false) {
  const saved = new Map<string, Buffer>();
  const bucket: PhotoBucket = {
    file: (path) => ({
      save: async (data) => {
        if (fail) throw new Error('storage down');
        saved.set(path, data);
      },
    }),
  };
  return { bucket, saved };
}

describe('kiosk photos', () => {
  it('saves the entry and exit photos and their documents', async () => {
    const { bucket, saved } = fakeBucket();
    const inRes = await kioskPunchCore({ db: db(), now: T, bucket }, { token: TOKEN, rut: '12345678-5', action: 'in', photo: `data:image/jpeg;base64,${JPEG}` });
    expect(inRes.photo).toBe(true);
    expect(inRes).not.toHaveProperty('sessionId');
    const snap = await db().collection('sessions').where('uid', '==', 'ana').get();
    const id = snap.docs[0]!.id;
    const path = `attendancePhotos/ana/2026-11-10/${id}-in.jpg`;
    expect(saved.get(path)?.toString('base64')).toBe(JPEG);
    expect(await getDoc(`attendancePhotos/${id}_in`)).toEqual({
      uid: 'ana', sessionId: id, kind: 'in', at: T, date: '2026-11-10', kioskId: KIOSK, path,
    });
    const out = await kioskPunchCore({ db: db(), now: T + 3_600_000, bucket }, { token: TOKEN, rut: '12345678-5', action: 'out', photo: JPEG });
    expect(out.photo).toBe(true);
    expect(await getDoc(`attendancePhotos/${id}_out`)).toMatchObject({ kind: 'out', at: T + 3_600_000 });
  });

  it('marks anyway without a valid photo or when Storage fails', async () => {
    const { bucket, saved } = fakeBucket();
    await expect(
      kioskPunchCore({ db: db(), now: T, bucket }, { token: TOKEN, rut: '12345678-5', action: 'in', photo: 'bm90IGEganBlZw==' }),
    ).resolves.toMatchObject({ action: 'in', photo: false });
    expect(saved.size).toBe(0);
    const failing = fakeBucket(true);
    await expect(
      kioskPunchCore({ db: db(), now: T + 60_000, bucket: failing.bucket }, { token: TOKEN, rut: '12345678-5', action: 'out', photo: JPEG }),
    ).resolves.toMatchObject({ action: 'out', photo: false });
    expect((await db().collection('attendancePhotos').get()).size).toBe(0);
  });

  it('decodeKioskPhoto accepts only small JPEGs', () => {
    expect(decodeKioskPhoto(JPEG)?.length).toBe(8);
    expect(decodeKioskPhoto(undefined)).toBeNull();
    expect(decodeKioskPhoto('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
    expect(decodeKioskPhoto(Buffer.alloc(300 * 1024, 0xff).toString('base64'))).toBeNull();
  });
});

describe('kioskPunchCore', () => {
  it('marks entry and exit with the RUT, as a kiosk work day', async () => {
    await expect(punch('12.345.678-5', 'in')).resolves.toEqual({ action: 'in', firstName: 'Ana', at: T, startedAt: T, photo: false });
    let [s] = await sessionsOf('ana');
    expect(s).toMatchObject({ startedAt: T, endedAt: null, source: 'kiosk', kioskId: KIOSK });
    expect((await rejection(punch('123456785', 'in', T + 60_000))).reason).toBe('already-in');

    const out = T + 8 * 3_600_000;
    await expect(punch('12345678-5', 'out', out)).resolves.toMatchObject({ action: 'out', startedAt: T, at: out });
    [s] = await sessionsOf('ana');
    expect(s).toMatchObject({ endedAt: out, endReason: 'manual', closedByKioskId: KIOSK });
    expect((await rejection(punch('12345678-5', 'out', out + 1))).reason).toBe('not-in');
    expect((await getDoc<{ lastUsedAt: number }>(`kiosks/${KIOSK}`))?.lastUsedAt).toBe(out);
  });

  it('closes a forgotten exit of a previous day at the end of its schedule', async () => {
    const yesterday = at('2026-11-09', '09:00');
    await seed({ 'sessions/old': { uid: 'ana', startedAt: yesterday, endedAt: null, endReason: null, lastHeartbeatAt: yesterday, source: 'kiosk' } });
    expect((await rejection(punch('12345678-5', 'out'))).reason).toBe('not-in');
    await punch('12345678-5', 'in');
    const [old, today] = await sessionsOf('ana');
    expect(old).toMatchObject({ endedAt: at('2026-11-09', '18:30'), endReason: 'auto' });
    expect(today).toMatchObject({ startedAt: T, endedAt: null });
  });

  it('closes an open extension work day on exit (mode both)', async () => {
    await seed({
      'attendanceSettings/ana': settings('12345678-5', 'both'),
      'sessions/ext': { uid: 'ana', startedAt: T - 3_600_000, endedAt: null, endReason: null, lastHeartbeatAt: T - 60_000 },
    });
    expect((await rejection(punch('12345678-5', 'in'))).reason).toBe('already-in');
    await punch('12345678-5', 'out');
    expect(await getDoc('sessions/ext')).toMatchObject({ endedAt: T, endReason: 'manual', closedByKioskId: KIOSK });
  });

  it('rejects unknown or revoked kiosks, bad RUTs and people who cannot mark here', async () => {
    expect((await rejection(punch('12345678-5', 'in', T, 'z'.repeat(43)))).reason).toBe('kiosk-unknown');
    expect((await rejection(kioskPunchCore({ db: db(), now: T }, { token: TOKEN, rut: '1', action: 'x' }))).reason).toBe('bad-request');
    expect((await rejection(punch('12345678-4', 'in'))).reason).toBe('rut-invalid');
    expect((await rejection(punch('22222222-2', 'in'))).reason).toBe('rut-unknown');
    expect((await rejection(punch('7654321-6', 'in'))).reason).toBe('kiosk-not-allowed');
    expect((await rejection(punch('11111111-1', 'in'))).reason).toBe('user-disabled');
    await seed({ 'attendanceSettings/beto': settings('12345678-5', 'both') });
    expect((await rejection(punch('12345678-5', 'in'))).reason).toBe('rut-duplicated');
    await seed({ [`kiosks/${KIOSK}`]: { name: 'Recepción', createdAt: 1, createdBy: 'admin', revokedAt: 2 } });
    expect((await rejection(punch('7654321-6', 'in'))).reason).toBe('kiosk-revoked');
    expect(await sessionsOf('ana')).toEqual([]);
  });
});

describe('decideAutoClose for kiosk work days', () => {
  it('waits for MAX_SESSION_MS and ends at the schedule', () => {
    const s = { startedAt: T, lastHeartbeatAt: T, source: 'kiosk' as const };
    const week = { mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: null, sun: null };
    expect(decideAutoClose(s, T + 2 * 3_600_000).close).toBe(false);
    expect(decideAutoClose(s, T + 17 * 3_600_000, { week, holidays: [] })).toEqual({ close: true, endedAt: at('2026-11-10', '18:30') });
  });
});
