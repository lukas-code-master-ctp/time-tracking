import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { zonedDateTimeToMs } from '@timetracking/shared';
import { sendDailyReportRemindersCore } from '../../src/core/dailyReportReminder.js';
import type { EmailMessage } from '../../src/core/email.js';
import { clearFirestore, closeAdmin, db, getDoc, seed } from './helpers.js';

const DATE = '2026-11-13'; // Friday
const user = (email: string, status = 'active') => ({ email, displayName: 'Ana Pérez', photoURL: null, role: 'member', status, createdAt: 1 });
const day = { start: '09:00', end: '18:00', lunchStart: '13:00', lunchEnd: '14:00' };
const week = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: null, sun: null };

let sent: EmailMessage[] = [];
const quiet = { info: () => undefined, warn: () => undefined };
const run = (now: number) =>
  sendDailyReportRemindersCore({
    db: db(),
    now,
    link: 'https://app.mipegahr.cl/terreno',
    config: { apiKey: 'k', from: 'Mi Pega HR <n@mipegahr.cl>' },
    isEmulator: false,
    emailEnabled: true,
    send: async (_c, m) => {
      sent.push(m);
    },
    logger: quiet,
  });

beforeEach(async () => {
  sent = [];
  await clearFirestore();
  await seed({
    'users/ana': user('ana@impulseai.cl'),
    'users/beto': user('beto@impulseai.cl'),
    'users/carla': user('carla@impulseai.cl'),
    'users/dani': user('dani@impulseai.cl', 'disabled'),
    'users/eva': user('eva@impulseai.cl'),
    'config/org': { dailyReportEnabled: true, dailyReportGroupIds: ['terreno'] },
    'config/schedule': { week, holidays: [], toleranceMinutes: 5, remindersEnabled: true, updatedAt: 1, updatedBy: 'admin' },
    // Beto finishes at 20:00 on Fridays.
    'schedules/beto': { week: { ...week, fri: { ...day, end: '20:00' } }, updatedAt: 1, updatedBy: 'admin' },
    'groups/terreno': { name: 'Terreno', memberUids: ['ana', 'beto', 'carla', 'dani', 'eva'], createdAt: 1, createdBy: 'admin', updatedAt: 1, updatedBy: 'admin' },
    // Carla already sent hers; Eva is on vacation.
    [`dailyReports/carla_${DATE}`]: { uid: 'carla', date: DATE, text: '- Listo.', source: 'text', transcript: null, createdAt: 1, updatedAt: 1 },
    'absences/a1': { uid: 'eva', type: 'vacation', startDate: '2026-11-10', endDate: '2026-11-20', startTime: null, endTime: null, note: '', status: 'approved', createdAt: 1, createdBy: 'admin', updatedAt: 1, updatedBy: 'admin' },
  });
});

afterAll(async () => {
  await closeAdmin();
});

describe('sendDailyReportRemindersCore', () => {
  it('emails whoever finished and has not sent the report, once', async () => {
    expect((await run(zonedDateTimeToMs(DATE, '17:45'))).reminded).toEqual([]);

    const r = await run(zonedDateTimeToMs(DATE, '18:05'));
    expect(r.reminded).toEqual(['ana']);
    expect(sent.map((m) => m.to)).toEqual(['ana@impulseai.cl']);
    expect(await getDoc(`dailyReportReminders/ana_${DATE}`)).toMatchObject({ uid: 'ana', date: DATE });

    // Next run: Ana is not emailed again; Beto after his own 20:00.
    expect((await run(zonedDateTimeToMs(DATE, '18:20'))).reminded).toEqual([]);
    expect((await run(zonedDateTimeToMs(DATE, '20:10'))).reminded).toEqual(['beto']);
    expect(sent).toHaveLength(2);
  });

  it('does nothing when the daily report is off', async () => {
    await seed({ 'config/org': { dailyReportEnabled: false, dailyReportGroupIds: ['terreno'] } });
    expect(await run(zonedDateTimeToMs(DATE, '18:05'))).toEqual({ asked: 0, reminded: [] });
    expect(sent).toEqual([]);
  });
});
