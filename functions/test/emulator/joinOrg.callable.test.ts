/**
 * Calls the deployed-shape `joinOrg` through the Functions emulator with real
 * Auth emulator ID tokens. The emulator loads `functions/lib/index.js` (built
 * by the root `test:emulator` script) and `functions/.env.demo-timetracking`
 * (BOOTSTRAP_ADMINS=lukas@impulseai.cl).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserProfile } from '@timetracking/shared';
import {
  NOW,
  callFunction,
  clearAuth,
  clearFirestore,
  closeAdmin,
  functionsEmulatorUp,
  getDoc,
  idTokenFor,
  seed,
} from './helpers.js';

let up = false;

beforeAll(async () => {
  up = await functionsEmulatorUp();
  if (!up) console.warn('Functions emulator not running: skipping joinOrg callable tests.');
});

beforeEach(async () => {
  await clearFirestore();
  await clearAuth();
});

afterAll(async () => {
  await closeAdmin();
});

describe('joinOrg callable (Functions emulator)', () => {
  it('registers the bootstrap admin and is idempotent', async (ctx) => {
    if (!up) ctx.skip();
    const token = await idTokenFor({
      uid: 'boss',
      email: 'lukas@impulseai.cl',
      emailVerified: true,
      displayName: 'Lukas',
    });
    const first = await callFunction<{ profile: UserProfile }>('joinOrg', {}, token);
    expect(first.error).toBeUndefined();
    expect(first.result?.profile).toMatchObject({
      email: 'lukas@impulseai.cl',
      displayName: 'Lukas',
      role: 'admin',
      status: 'active',
    });
    expect(await getDoc('users/boss')).toEqual(first.result?.profile);
    expect(await getDoc('config/org')).toMatchObject({ allowedDomains: ['impulseai.cl', 'compratuparcela.cl'] });

    const second = await callFunction<{ profile: UserProfile }>('joinOrg', {}, token);
    expect(second.result).toEqual(first.result);
  });

  it('registers an invited member', async (ctx) => {
    if (!up) ctx.skip();
    await seed({
      'invitations/ana@compratuparcela.cl': {
        email: 'ana@compratuparcela.cl',
        invitedBy: 'boss',
        invitedAt: NOW,
        status: 'pending',
      },
    });
    const token = await idTokenFor({ uid: 'ana', email: 'ana@compratuparcela.cl', emailVerified: true });
    const res = await callFunction<{ profile: UserProfile }>('joinOrg', {}, token);
    expect(res.result?.profile).toMatchObject({ role: 'member', displayName: 'ana' });
    expect(await getDoc('invitations/ana@compratuparcela.cl')).toMatchObject({ status: 'accepted' });
  });

  it('accepts invited members of both domains and rejects other domains (env list)', async (ctx) => {
    if (!up) ctx.skip();
    const inv = (email: string) => ({ email, invitedBy: 'boss', invitedAt: NOW, status: 'pending' });
    await seed({
      'invitations/x@impulseai.cl': inv('x@impulseai.cl'),
      'invitations/z@gmail.com': inv('z@gmail.com'),
      'invitations/a@sub.impulseai.cl': inv('a@sub.impulseai.cl'),
    });
    const x = await callFunction<{ profile: UserProfile }>(
      'joinOrg',
      {},
      await idTokenFor({ uid: 'x', email: 'x@impulseai.cl', emailVerified: true }),
    );
    expect(x.result?.profile).toMatchObject({ email: 'x@impulseai.cl', role: 'member' });
    for (const [uid, email] of [['z', 'z@gmail.com'], ['a', 'a@sub.impulseai.cl']] as const) {
      const res = await callFunction('joinOrg', {}, await idTokenFor({ uid, email, emailVerified: true }));
      expect(res.error).toMatchObject({
        status: 'PERMISSION_DENIED',
        message: 'Usa tu cuenta de la empresa (@impulseai.cl o @compratuparcela.cl).',
        details: { reason: 'domain-not-allowed' },
      });
      expect(await getDoc(`users/${uid}`)).toBeUndefined();
    }
  });

  it('rejects without invitation with PERMISSION_DENIED and a reason', async (ctx) => {
    if (!up) ctx.skip();
    const token = await idTokenFor({ uid: 'x', email: 'x@compratuparcela.cl', emailVerified: true });
    const res = await callFunction('joinOrg', {}, token);
    expect(res.status).toBe(403);
    expect(res.error).toMatchObject({
      status: 'PERMISSION_DENIED',
      message: expect.stringContaining('invitación'),
      details: { reason: 'no-invitation' },
    });
    expect(await getDoc('users/x')).toBeUndefined();
  });

  it('rejects an unverified email and an unauthenticated call', async (ctx) => {
    if (!up) ctx.skip();
    const token = await idTokenFor({ uid: 'y', email: 'lukas2@impulseai.cl', emailVerified: false });
    const unverified = await callFunction('joinOrg', {}, token);
    expect(unverified.error).toMatchObject({ status: 'PERMISSION_DENIED', details: { reason: 'email-not-verified' } });

    const anonymous = await callFunction('joinOrg', {});
    expect(anonymous.error).toMatchObject({ status: 'UNAUTHENTICATED' });
  });
});
