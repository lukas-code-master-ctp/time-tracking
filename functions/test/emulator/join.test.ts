import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultOrgConfig, type Invitation, type OrgConfig, type UserProfile } from '@timetracking/shared';
import { joinOrgCore, type JoinCaller, type JoinDeps } from '../../src/core/join.js';
import { NOW, clearFirestore, closeAdmin, db, getDoc, seed } from './helpers.js';

const DOMAINS = ['impulseai.cl', 'compratuparcela.cl'];

const deps = (overrides: Partial<JoinDeps> = {}): JoinDeps => ({
  db: db(),
  now: NOW,
  fallbackAllowedDomains: DOMAINS,
  bootstrapAdmins: ['lukas@impulseai.cl'],
  ...overrides,
});

const caller = (overrides: Partial<JoinCaller> = {}): JoinCaller => ({
  uid: 'u1',
  email: 'ana@compratuparcela.cl',
  emailVerified: true,
  displayName: 'Ana Pérez',
  photoURL: 'https://example.test/ana.png',
  ...overrides,
});

const invitation = (overrides: Partial<Invitation> = {}): Invitation => ({
  email: 'ana@compratuparcela.cl',
  invitedBy: 'admin1',
  invitedAt: NOW - 1000,
  status: 'pending',
  ...overrides,
});

const rejectsWith = (p: Promise<unknown>, code: string, reason: string) =>
  expect(p).rejects.toMatchObject({ code, details: { reason } });

beforeEach(async () => {
  await clearFirestore();
});

afterAll(async () => {
  await closeAdmin();
});

describe('joinOrgCore: bootstrap admin', () => {
  it('registers a bootstrap admin without invitation and creates config/org', async () => {
    const res = await joinOrgCore(deps(), caller({ uid: 'boss', email: 'Lukas@ImpulseAI.cl' }));
    expect(res.created).toBe(true);
    expect(res.profile).toEqual<UserProfile>({
      email: 'lukas@impulseai.cl',
      displayName: 'Ana Pérez',
      photoURL: 'https://example.test/ana.png',
      role: 'admin',
      status: 'active',
      createdAt: NOW,
    });
    expect(await getDoc('users/boss')).toEqual(res.profile);
    expect(await getDoc<OrgConfig>('config/org')).toEqual(defaultOrgConfig(NOW, DOMAINS, 'system'));
  });

  it('does not overwrite an existing config/org', async () => {
    const existing = { ...defaultOrgConfig(1, DOMAINS, 'someone'), screenshotsEnabled: true };
    await seed({ 'config/org': existing });
    await joinOrgCore(deps(), caller({ uid: 'boss', email: 'lukas@impulseai.cl' }));
    expect(await getDoc('config/org')).toEqual(existing);
  });

  it('bootstrap wins over an invitation (admin) and marks it accepted', async () => {
    await seed({ 'invitations/lukas@impulseai.cl': invitation({ email: 'lukas@impulseai.cl' }) });
    const res = await joinOrgCore(deps(), caller({ uid: 'boss', email: 'lukas@impulseai.cl' }));
    expect(res.profile.role).toBe('admin');
    expect(await getDoc<Invitation>('invitations/lukas@impulseai.cl')).toMatchObject({
      status: 'accepted',
      acceptedAt: NOW,
    });
  });
});

describe('joinOrgCore: several allowed domains', () => {
  it('registers invited users of both domains', async () => {
    await seed({
      'invitations/x@impulseai.cl': invitation({ email: 'x@impulseai.cl' }),
      'invitations/y@compratuparcela.cl': invitation({ email: 'y@compratuparcela.cl' }),
    });
    const x = await joinOrgCore(deps(), caller({ uid: 'x', email: 'x@impulseai.cl' }));
    const y = await joinOrgCore(deps(), caller({ uid: 'y', email: 'Y@CompraTuParcela.cl' }));
    expect(x.profile).toMatchObject({ email: 'x@impulseai.cl', role: 'member' });
    expect(y.profile).toMatchObject({ email: 'y@compratuparcela.cl', role: 'member' });
  });

  it('rejects a domain that is not in the list, subdomains and look-alikes', async () => {
    for (const email of ['z@gmail.com', 'a@sub.impulseai.cl', 'a@evilimpulseai.cl', 'a@impulseai.cl.evil.test']) {
      await seed({ [`invitations/${email}`]: invitation({ email }) });
      await rejectsWith(joinOrgCore(deps(), caller({ uid: 'z', email })), 'permission-denied', 'domain-not-allowed');
    }
    expect((await db().collection('users').get()).size).toBe(0);
  });

  it('respects the list stored in config/org (a removed domain is rejected)', async () => {
    await seed({
      'config/org': defaultOrgConfig(1, ['impulseai.cl']),
      'invitations/y@compratuparcela.cl': invitation({ email: 'y@compratuparcela.cl' }),
      'invitations/x@impulseai.cl': invitation({ email: 'x@impulseai.cl' }),
    });
    await rejectsWith(
      joinOrgCore(deps(), caller({ uid: 'y', email: 'y@compratuparcela.cl' })),
      'permission-denied',
      'domain-not-allowed',
    );
    expect((await joinOrgCore(deps(), caller({ uid: 'x', email: 'x@impulseai.cl' }))).profile.role).toBe('member');
  });
});

describe('joinOrgCore: invited member', () => {
  it('registers an invited user as member and accepts the invitation', async () => {
    await seed({ 'invitations/ana@compratuparcela.cl': invitation() });
    const res = await joinOrgCore(deps(), caller());
    expect(res).toMatchObject({ created: true, profile: { role: 'member', status: 'active' } });
    expect(await getDoc<UserProfile>('users/u1')).toMatchObject({
      email: 'ana@compratuparcela.cl',
      role: 'member',
      createdAt: NOW,
    });
    expect(await getDoc<Invitation>('invitations/ana@compratuparcela.cl')).toEqual({
      ...invitation(),
      status: 'accepted',
      acceptedAt: NOW,
    });
    // A member never creates the org config.
    expect(await getDoc('config/org')).toBeUndefined();
  });

  it('matches the invitation case-insensitively (token email with capitals)', async () => {
    await seed({ 'invitations/ana@compratuparcela.cl': invitation() });
    const res = await joinOrgCore(deps(), caller({ email: ' Ana@CompraTuParcela.CL ' }));
    expect(res.profile).toMatchObject({ email: 'ana@compratuparcela.cl', role: 'member' });
    expect(await getDoc<Invitation>('invitations/ana@compratuparcela.cl')).toMatchObject({ status: 'accepted' });
  });

  it('rejects subdomains and look-alike domains even with a matching invitation id', async () => {
    for (const email of ['ana@x.compratuparcela.cl', 'ana@compratuparcela.cl.evil.test', 'ana@evilcompratuparcela.cl']) {
      await seed({ [`invitations/${email}`]: invitation({ email }) });
      await rejectsWith(joinOrgCore(deps(), caller({ email })), 'permission-denied', 'domain-not-allowed');
    }
    expect((await db().collection('users').get()).size).toBe(0);
  });

  it('accepts an already accepted invitation (user doc was removed) without changing it', async () => {
    const accepted = invitation({ status: 'accepted', acceptedAt: NOW - 500 });
    await seed({ 'invitations/ana@compratuparcela.cl': accepted });
    const res = await joinOrgCore(deps(), caller());
    expect(res.profile.role).toBe('member');
    expect(await getDoc('invitations/ana@compratuparcela.cl')).toEqual(accepted);
  });

  it('falls back to the email local part and null photo when the token has none', async () => {
    await seed({ 'invitations/ana@compratuparcela.cl': invitation() });
    const res = await joinOrgCore(deps(), caller({ displayName: undefined, photoURL: undefined }));
    expect(res.profile).toMatchObject({ displayName: 'ana', photoURL: null });
  });
});

describe('joinOrgCore: rejections', () => {
  it('rejects an unauthenticated call', async () => {
    await rejectsWith(joinOrgCore(deps(), null), 'unauthenticated', 'unauthenticated');
  });

  it('rejects a user without invitation', async () => {
    await rejectsWith(joinOrgCore(deps(), caller()), 'permission-denied', 'no-invitation');
    expect(await getDoc('users/u1')).toBeUndefined();
  });

  it('rejects another domain even with an invitation', async () => {
    await seed({ 'invitations/ana@otra.cl': invitation({ email: 'ana@otra.cl' }) });
    await rejectsWith(
      joinOrgCore(deps(), caller({ email: 'ana@otra.cl' })),
      'permission-denied',
      'domain-not-allowed',
    );
    // Subdomains and look-alikes too.
    await rejectsWith(
      joinOrgCore(deps(), caller({ email: 'ana@x.compratuparcela.cl' })),
      'permission-denied',
      'domain-not-allowed',
    );
    expect(await getDoc('users/u1')).toBeUndefined();
  });

  it('rejects a bootstrap email of another domain', async () => {
    await rejectsWith(
      joinOrgCore(deps({ bootstrapAdmins: ['boss@otra.cl'] }), caller({ email: 'boss@otra.cl' })),
      'permission-denied',
      'domain-not-allowed',
    );
  });

  it('uses config/org.allowedDomains over the fallback', async () => {
    await seed({
      'config/org': defaultOrgConfig(1, ['otra.cl']),
      'invitations/ana@otra.cl': invitation({ email: 'ana@otra.cl' }),
      'invitations/ana@compratuparcela.cl': invitation(),
    });
    const res = await joinOrgCore(deps(), caller({ uid: 'u2', email: 'ana@otra.cl' }));
    expect(res.profile.role).toBe('member');
    await rejectsWith(joinOrgCore(deps(), caller()), 'permission-denied', 'domain-not-allowed');
  });

  it('reads an old config/org with a single allowedDomain as a one-item list', async () => {
    const legacy = { ...defaultOrgConfig(1), allowedDomain: 'otra.cl' } as Record<string, unknown>;
    delete legacy.allowedDomains;
    await seed({
      'config/org': legacy,
      'invitations/ana@otra.cl': invitation({ email: 'ana@otra.cl' }),
      'invitations/ana@compratuparcela.cl': invitation(),
    });
    const res = await joinOrgCore(deps(), caller({ uid: 'u2', email: 'ana@otra.cl' }));
    expect(res.profile.role).toBe('member');
    await rejectsWith(joinOrgCore(deps(), caller()), 'permission-denied', 'domain-not-allowed');
  });

  it('the domain message lists every allowed domain', async () => {
    await seed({ 'invitations/z@gmail.com': invitation({ email: 'z@gmail.com' }) });
    await expect(joinOrgCore(deps(), caller({ email: 'z@gmail.com' }))).rejects.toMatchObject({
      message: 'Usa tu cuenta de la empresa (@impulseai.cl o @compratuparcela.cl).',
      details: { reason: 'domain-not-allowed' },
    });
  });

  it('rejects unverified or missing emails', async () => {
    await seed({ 'invitations/ana@compratuparcela.cl': invitation() });
    await rejectsWith(
      joinOrgCore(deps(), caller({ emailVerified: false })),
      'permission-denied',
      'email-not-verified',
    );
    await rejectsWith(
      joinOrgCore(deps(), caller({ emailVerified: undefined })),
      'permission-denied',
      'email-not-verified',
    );
    await rejectsWith(joinOrgCore(deps(), caller({ email: undefined })), 'permission-denied', 'no-email');
    expect(await getDoc('users/u1')).toBeUndefined();
    expect(await getDoc<Invitation>('invitations/ana@compratuparcela.cl')).toMatchObject({ status: 'pending' });
  });

  it('rejects a revoked invitation', async () => {
    await seed({ 'invitations/ana@compratuparcela.cl': invitation({ status: 'revoked' }) });
    await rejectsWith(joinOrgCore(deps(), caller()), 'permission-denied', 'invitation-revoked');
    expect(await getDoc('users/u1')).toBeUndefined();
  });

  it('rejects a disabled user', async () => {
    const disabled: UserProfile = {
      email: 'ana@compratuparcela.cl',
      displayName: 'Ana',
      photoURL: null,
      role: 'member',
      status: 'disabled',
      createdAt: 1,
    };
    await seed({ 'users/u1': disabled, 'invitations/ana@compratuparcela.cl': invitation({ status: 'accepted' }) });
    await rejectsWith(joinOrgCore(deps(), caller()), 'permission-denied', 'user-disabled');
    expect(await getDoc('users/u1')).toEqual(disabled);
  });
});

describe('joinOrgCore: idempotency', () => {
  it('returns the same profile on repeated calls without rewriting it', async () => {
    await seed({ 'invitations/ana@compratuparcela.cl': invitation() });
    const first = await joinOrgCore(deps(), caller());
    const second = await joinOrgCore(deps({ now: NOW + 60_000 }), caller({ displayName: 'Otro nombre' }));
    expect(second).toEqual({ profile: first.profile, created: false });
    expect(await getDoc('users/u1')).toEqual(first.profile);
    expect(await getDoc<Invitation>('invitations/ana@compratuparcela.cl')).toMatchObject({ acceptedAt: NOW });
  });

  it('keeps the existing role (admin promoted from the portal) and ignores a later revocation', async () => {
    const admin: UserProfile = {
      email: 'ana@compratuparcela.cl',
      displayName: 'Ana',
      photoURL: null,
      role: 'admin',
      status: 'active',
      createdAt: 1,
    };
    await seed({ 'users/u1': admin, 'invitations/ana@compratuparcela.cl': invitation({ status: 'revoked' }) });
    const res = await joinOrgCore(deps({ bootstrapAdmins: [] }), caller());
    expect(res).toEqual({ profile: admin, created: false });
  });

  it('concurrent first calls create a single profile', async () => {
    await seed({ 'invitations/ana@compratuparcela.cl': invitation() });
    const results = await Promise.all([joinOrgCore(deps(), caller()), joinOrgCore(deps(), caller())]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]!.profile).toEqual(results[1]!.profile);
  });
});
