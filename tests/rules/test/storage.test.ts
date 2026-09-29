import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { as, createEnv, seedUsers } from './env.js';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createEnv();
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await seedUsers(env);
});

const storage = (uid: string | null) => as(env, uid).storage();
const JPEG = { contentType: 'image/jpeg' };
const bytes = (n: number) => new Uint8Array(n);
const path = (uid: string, file = 'shot1.jpg', date = '2026-09-29') =>
  `screenshots/${uid}/${date}/${file}`;

/** Uploads a file bypassing rules. */
async function seedFile(p: string): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.storage().ref(p).put(bytes(10), JPEG);
  });
}

describe('storage: screenshots upload', () => {
  it('active member uploads a small JPEG to its own folder', async () => {
    await assertSucceeds(storage('alice').ref(path('alice')).put(bytes(1024), JPEG).then());
  });

  it('rejects files of 1 MB or more', async () => {
    await assertFails(storage('alice').ref(path('alice')).put(bytes(1024 * 1024), JPEG).then());
    await assertSucceeds(storage('alice').ref(path('alice', 'b.jpg')).put(bytes(1024 * 1024 - 1), JPEG).then());
  });

  it('rejects content types other than image/jpeg', async () => {
    await assertFails(storage('alice').ref(path('alice')).put(bytes(10), { contentType: 'image/png' }).then());
    await assertFails(storage('alice').ref(path('alice')).put(bytes(10), { contentType: 'text/html' }).then());
  });

  it("rejects uploads to another user's folder", async () => {
    await assertFails(storage('alice').ref(path('bob')).put(bytes(10), JPEG).then());
    await assertFails(storage('admin').ref(path('bob')).put(bytes(10), JPEG).then());
  });

  it('rejects paths outside screenshots/{uid}/{YYYY-MM-DD}/{id}.jpg', async () => {
    const alice = storage('alice');
    await assertFails(alice.ref('screenshots/alice/shot1.jpg').put(bytes(10), JPEG).then());
    await assertFails(alice.ref('screenshots/alice/hoy/shot1.jpg').put(bytes(10), JPEG).then());
    await assertFails(alice.ref(path('alice', 'shot1.png')).put(bytes(10), JPEG).then());
    await assertFails(alice.ref('screenshots/alice/2026-09-29/x/shot1.jpg').put(bytes(10), JPEG).then());
    await assertFails(alice.ref('otra/alice/2026-09-29/shot1.jpg').put(bytes(10), JPEG).then());
  });

  it('disabled user, user without doc and anonymous cannot upload', async () => {
    await assertFails(storage('dave').ref(path('dave')).put(bytes(10), JPEG).then());
    await assertFails(storage('nodoc').ref(path('nodoc')).put(bytes(10), JPEG).then());
    await assertFails(storage(null).ref(path('alice')).put(bytes(10), JPEG).then());
  });

  it('files cannot be overwritten or deleted from clients', async () => {
    await seedFile(path('alice'));
    await assertFails(storage('alice').ref(path('alice')).put(bytes(10), JPEG).then());
    await assertFails(storage('alice').ref(path('alice')).delete());
    await assertFails(storage('admin').ref(path('alice')).delete());
  });
});

describe('storage: screenshots read', () => {
  beforeEach(async () => {
    await seedFile(path('alice'));
  });

  it('owner reads its own file', async () => {
    await assertSucceeds(storage('alice').ref(path('alice')).getMetadata());
  });

  it('other members cannot read it', async () => {
    await assertFails(storage('bob').ref(path('alice')).getMetadata());
    await assertFails(storage(null).ref(path('alice')).getMetadata());
  });

  it('admin reads it; disabled admin does not', async () => {
    await assertSucceeds(storage('admin').ref(path('alice')).getMetadata());
    await assertFails(storage('eve').ref(path('alice')).getMetadata());
  });
});
