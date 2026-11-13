import { describe, expect, it } from 'vitest';
import {
  DAILY_REPORT_REMINDER_WINDOW_MS,
  dailyReportReminderDue,
  encodeWav,
  toBase64,
  zonedDateTimeToMs,
  dailyReportAudioType,
  dailyReportDocId,
  parseDailyReportDraft,
  readDailyReportSettings,
  requiresDailyReport,
  validateDailyReport,
  type DailyReport,
} from '../src/index.js';

const report: DailyReport = {
  uid: 'u1',
  date: '2026-11-13',
  text: '- Visité Maipú.',
  source: 'text',
  transcript: null,
  createdAt: 1,
  updatedAt: 2,
};

describe('daily reports', () => {
  it('reads the settings and who is asked', () => {
    expect(readDailyReportSettings(null)).toEqual({ enabled: false, groupIds: [] });
    const s = readDailyReportSettings({ dailyReportEnabled: true, dailyReportGroupIds: ['a', 'a', '', 'b'] });
    expect(s).toEqual({ enabled: true, groupIds: ['a', 'b'] });
    expect(requiresDailyReport(s, ['x', 'b'])).toBe(true);
    expect(requiresDailyReport(s, ['x'])).toBe(false);
    expect(requiresDailyReport({ ...s, enabled: false }, ['a'])).toBe(false);
    // People in the field always, when the report is on (even without groups).
    expect(requiresDailyReport({ enabled: true, groupIds: [] }, [], { workplace: 'field' })).toBe(true);
    expect(requiresDailyReport({ enabled: true, groupIds: [] }, [], { workplace: 'office' })).toBe(false);
    expect(requiresDailyReport({ enabled: false, groupIds: [] }, [], { workplace: 'field' })).toBe(false);
  });

  it('builds the id', () => {
    expect(dailyReportDocId('u1', '2026-11-13')).toBe('u1_2026-11-13');
    expect(() => dailyReportDocId('u1', '13-11-2026')).toThrow();
  });

  it('validates reports', () => {
    expect(validateDailyReport(report)).toEqual([]);
    expect(validateDailyReport({ ...report, text: '  ' })).toEqual(['text']);
    expect(validateDailyReport({ ...report, text: 'x'.repeat(4001) })).toEqual(['text']);
    expect(validateDailyReport({ ...report, transcript: 'hola' })).toEqual(['transcript']);
    expect(validateDailyReport({ ...report, source: 'audio', transcript: 'hola' })).toEqual([]);
    expect(validateDailyReport({ ...report, updatedAt: 0 })).toEqual(['times']);
  });

  it('accepts WAV and MP3 audio only', () => {
    expect(dailyReportAudioType('audio/wav')).toBe('audio/wav');
    expect(dailyReportAudioType('audio/mpeg')).toBe('audio/mpeg');
    expect(dailyReportAudioType('audio/webm;codecs=opus')).toBeNull();
    expect(dailyReportAudioType(3)).toBeNull();
  });

  it('parses the model answer', () => {
    expect(parseDailyReportDraft('{"transcript":"a","minuta":" - b "}')).toEqual({ transcript: 'a', text: '- b' });
    expect(parseDailyReportDraft('```json\n{"transcript":"a","minuta":"b"}\n```')).toEqual({ transcript: 'a', text: 'b' });
    expect(parseDailyReportDraft('no json')).toBeNull();
    expect(parseDailyReportDraft({ transcript: 'a' })).toBeNull();
  });
});

describe('reminder of the people in the field', () => {
  const day = { start: '09:00', end: '18:00', lunchStart: null, lunchEnd: null };
  const week = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: null, sun: null };
  const date = '2026-11-13'; // Friday
  const end = zonedDateTimeToMs(date, '18:00');
  const base = { now: end + 60_000, date, week, holidays: [] as string[], absences: [], sent: false, reminded: false };

  it('is due after the end of the schedule, within the window', () => {
    expect(dailyReportReminderDue(base)).toBe(true);
    expect(dailyReportReminderDue({ ...base, now: end - 60_000 })).toBe(false);
    expect(dailyReportReminderDue({ ...base, now: end + DAILY_REPORT_REMINDER_WINDOW_MS })).toBe(false);
  });

  it('is not due when sent, reminded, off, a holiday or a full-day absence', () => {
    expect(dailyReportReminderDue({ ...base, sent: true })).toBe(false);
    expect(dailyReportReminderDue({ ...base, reminded: true })).toBe(false);
    expect(dailyReportReminderDue({ ...base, week: null })).toBe(false);
    expect(dailyReportReminderDue({ ...base, holidays: [date] })).toBe(false);
    const away = { startDate: '2026-11-12', endDate: '2026-11-14', startTime: null, endTime: null };
    expect(dailyReportReminderDue({ ...base, absences: [{ ...away, status: 'approved' }] })).toBe(false);
    expect(dailyReportReminderDue({ ...base, absences: [{ ...away, status: 'pending' }] })).toBe(true);
    expect(dailyReportReminderDue({ ...base, absences: [{ ...away, startTime: '09:00', endTime: '11:00' }] })).toBe(true);
  });
});

describe('wav', () => {
  it('encodes mono 16-bit PCM', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 12_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(12_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
    expect(toBase64(new Uint8Array([82, 73, 70, 70]))).toBe('UklGRg==');
  });
});
