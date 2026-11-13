import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAILY_REPORT_MAX_DRAFTS_PER_DAY, zonedDateTimeToMs } from '@timetracking/shared';
import { draftDailyReportCore, type DraftModel } from '../../src/core/dailyReportDraft.js';
import { clearFirestore, closeAdmin, db, getDoc, seed } from './helpers.js';

const NOW = zonedDateTimeToMs('2026-11-13', '18:30');
const AUDIO = Buffer.alloc(4000, 1).toString('base64');
const user = (status = 'active') => ({ email: 'a@impulseai.cl', displayName: 'Ana', photoURL: null, role: 'member', status, createdAt: 1 });

let calls = 0;
const model: DraftModel = async () => {
  calls++;
  return { transcript: 'Hoy visité Maipú.', text: '- Visité Maipú.' };
};
const run = (uid: string | null, req: unknown) =>
  draftDailyReportCore({ db: db(), now: NOW, model }, uid, req as { audio?: unknown; mimeType?: unknown });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error('expected a rejection');
}

beforeEach(async () => {
  calls = 0;
  await clearFirestore();
  await seed({
    'users/ana': user(),
    'users/beto': user(),
    'users/dani': user('disabled'),
    'config/org': { dailyReportEnabled: true, dailyReportGroupIds: ['terreno'] },
    'groups/terreno': { name: 'Terreno', memberUids: ['ana', 'dani'] },
  });
});

afterAll(async () => {
  await closeAdmin();
});

describe('draftDailyReportCore', () => {
  it('drafts for a member of the groups and counts it', async () => {
    expect(await run('ana', { audio: AUDIO, mimeType: 'audio/wav' })).toEqual({ transcript: 'Hoy visité Maipú.', text: '- Visité Maipú.' });
    expect(await getDoc('dailyReportDrafts/ana_2026-11-13')).toMatchObject({ uid: 'ana', count: 1 });
  });

  it('refuses people outside the groups, disabled ones and bad audio, without calling the model', async () => {
    expect(await code(run(null, { audio: AUDIO, mimeType: 'audio/wav' }))).toBe('unauthenticated');
    expect(await code(run('beto', { audio: AUDIO, mimeType: 'audio/wav' }))).toBe('failed-precondition');
    expect(await code(run('dani', { audio: AUDIO, mimeType: 'audio/wav' }))).toBe('permission-denied');
    expect(await code(run('ana', { audio: AUDIO, mimeType: 'audio/webm' }))).toBe('invalid-argument');
    expect(await code(run('ana', { audio: 'no base64!', mimeType: 'audio/wav' }))).toBe('invalid-argument');
    expect(await code(run('ana', { audio: 'UklGRg==', mimeType: 'audio/wav' }))).toBe('invalid-argument');
    expect(calls).toBe(0);
  });

  it('stops after the daily limit', async () => {
    await seed({ 'dailyReportDrafts/ana_2026-11-13': { uid: 'ana', date: '2026-11-13', count: DAILY_REPORT_MAX_DRAFTS_PER_DAY, updatedAt: 1 } });
    expect(await code(run('ana', { audio: AUDIO, mimeType: 'audio/wav' }))).toBe('resource-exhausted');
    expect(calls).toBe(0);
  });
});
