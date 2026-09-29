import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultOrgConfig, screenshotStoragePath, type ScreenshotMeta } from '@timetracking/shared';
import { purgeOldScreenshotsCore, type BucketLike } from '../../src/core/purge.js';
import { DAY, NOW, bucket, clearFirestore, clearStorage, closeAdmin, db, getDoc, seed } from './helpers.js';

function shot(uid: string, id: string, takenAt: number): ScreenshotMeta {
  return {
    uid,
    sessionId: 's1',
    takenAt,
    storagePath: screenshotStoragePath(uid, takenAt, id),
    blurred: true,
    width: 1280,
    height: 720,
  };
}

async function seedShot(id: string, meta: ScreenshotMeta, withFile = true): Promise<void> {
  await seed({ [`screenshots/${id}`]: meta });
  if (withFile) {
    await bucket().file(meta.storagePath).save(Buffer.from('jpeg'), { contentType: 'image/jpeg' });
  }
}

const fileExists = async (path: string) => (await bucket().file(path).exists())[0];

beforeEach(async () => {
  await clearFirestore();
  await clearStorage();
});

afterAll(async () => {
  await closeAdmin();
});

describe('purgeOldScreenshotsCore', () => {
  it('deletes docs and files older than the default 90 days, keeps newer ones', async () => {
    const old = shot('alice', 'old', NOW - 91 * DAY);
    const edge = shot('alice', 'edge', NOW - 90 * DAY); // exactly at the cutoff: kept
    const recent = shot('bob', 'recent', NOW - 10 * DAY);
    await seedShot('old', old);
    await seedShot('edge', edge);
    await seedShot('recent', recent);

    const res = await purgeOldScreenshotsCore({ db: db(), bucket: bucket(), now: NOW });

    expect(res).toMatchObject({ retentionDays: 90, cutoff: NOW - 90 * DAY, deletedDocs: 1, failed: 0 });
    expect(await getDoc('screenshots/old')).toBeUndefined();
    expect(await fileExists(old.storagePath)).toBe(false);
    expect(await getDoc('screenshots/edge')).toBeDefined();
    expect(await fileExists(edge.storagePath)).toBe(true);
    expect(await getDoc('screenshots/recent')).toBeDefined();
    expect(await fileExists(recent.storagePath)).toBe(true);
  });

  it('respects config/org.screenshotRetentionDays', async () => {
    await seed({ 'config/org': { ...defaultOrgConfig(1), screenshotRetentionDays: 7 } });
    const eightDays = shot('alice', 'a', NOW - 8 * DAY);
    const sixDays = shot('alice', 'b', NOW - 6 * DAY);
    await seedShot('a', eightDays);
    await seedShot('b', sixDays);

    const res = await purgeOldScreenshotsCore({ db: db(), bucket: bucket(), now: NOW });

    expect(res).toMatchObject({ retentionDays: 7, deletedDocs: 1 });
    expect(await getDoc('screenshots/a')).toBeUndefined();
    expect(await fileExists(eightDays.storagePath)).toBe(false);
    expect(await getDoc('screenshots/b')).toBeDefined();
  });

  it('deletes the doc when the file is already gone (not-found is ignored)', async () => {
    await seedShot('ghost', shot('alice', 'ghost', NOW - 200 * DAY), false);
    const res = await purgeOldScreenshotsCore({ db: db(), bucket: bucket(), now: NOW });
    expect(res).toMatchObject({ deletedDocs: 1, failed: 0 });
    expect(await getDoc('screenshots/ghost')).toBeUndefined();
  });

  it('pages through many docs', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    for (const [i, id] of ids.entries()) await seedShot(id, shot('alice', id, NOW - (100 + i) * DAY));
    await seedShot('keep', shot('alice', 'keep', NOW - DAY));

    const res = await purgeOldScreenshotsCore({ db: db(), bucket: bucket(), now: NOW, pageSize: 5 });

    expect(res.deletedDocs).toBe(12);
    const left = await db().collection('screenshots').get();
    expect(left.docs.map((d) => d.id)).toEqual(['keep']);
    const [files] = await bucket().getFiles({ prefix: 'screenshots/' });
    expect(files.map((f) => f.name)).toEqual([shot('alice', 'keep', NOW - DAY).storagePath]);
  });

  it('keeps the doc (retried next run) when deleting the file fails, and never touches foreign paths', async () => {
    const failing = shot('alice', 'fail', NOW - 100 * DAY);
    const foreign: ScreenshotMeta = { ...shot('alice', 'foreign', NOW - 100 * DAY), storagePath: 'other/secret.jpg' };
    await seedShot('fail', failing);
    await seed({ 'screenshots/foreign': foreign });
    await bucket().file('other/secret.jpg').save(Buffer.from('x'));

    const deleted: string[] = [];
    const fakeBucket: BucketLike = {
      file: (path) => ({
        delete: async () => {
          deleted.push(path);
          if (path === failing.storagePath) throw new Error('boom');
        },
      }),
    };
    const res = await purgeOldScreenshotsCore({ db: db(), bucket: fakeBucket, now: NOW });

    expect(res).toMatchObject({ deletedDocs: 1, failed: 1 });
    expect(deleted).toEqual([failing.storagePath]);
    expect(await getDoc('screenshots/fail')).toBeDefined();
    expect(await getDoc('screenshots/foreign')).toBeUndefined();
    expect(await fileExists('other/secret.jpg')).toBe(true);
  });
});
