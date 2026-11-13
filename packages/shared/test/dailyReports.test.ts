import { describe, expect, it } from 'vitest';
import {
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
