import { describe, expect, it } from 'vitest';
import type { Invitation, OrgConfig, WithId } from '@timetracking/shared';
import {
  addDomain,
  buildInvitation,
  buildOrgConfig,
  buildResend,
  buildRevoke,
  canRemoveDomain,
  checkInvite,
  orgConfigToForm,
  sortInvitations,
  validateDomainList,
  validateOrgConfig,
} from '../src/lib/payloads';
import { member } from './fakes';

const NOW = 1_790_000_000_000;

describe('org config', () => {
  const form = {
    allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
    screenshotsEnabled: true,
    blurScreenshots: false,
    screenshotRetentionDays: '30',
    pauseTimerAtLunch: true,
  };

  it('builds the 6 fields the rules require, plus pauseTimerAtLunch only when on', () => {
    const cfg = buildOrgConfig({ ...form, allowedDomains: [' ImpulseAI.cl ', '@compratuparcela.cl', 'impulseai.cl'] }, 'uid-admin', NOW + 0.7);
    expect(cfg).toEqual({
      allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
      screenshotsEnabled: true,
      blurScreenshots: false,
      screenshotRetentionDays: 30,
      pauseTimerAtLunch: true,
      updatedAt: NOW,
      updatedBy: 'uid-admin',
    });
    expect(Object.keys(cfg).sort()).toEqual([
      'allowedDomains',
      'blurScreenshots',
      'pauseTimerAtLunch',
      'screenshotRetentionDays',
      'screenshotsEnabled',
      'updatedAt',
      'updatedBy',
    ]
    );
    expect(Number.isInteger(cfg.updatedAt)).toBe(true);
    expect('pauseTimerAtLunch' in buildOrgConfig({ ...form, pauseTimerAtLunch: false }, 'uid-admin', NOW)).toBe(false);
  });

  it('validates retention (integer 1..3650)', () => {
    for (const bad of ['0', '3651', '1.5', '', 'abc', '-3']) {
      expect(validateOrgConfig({ ...form, screenshotRetentionDays: bad }).screenshotRetentionDays).toBeTruthy();
    }
    for (const ok of ['1', '90', '3650']) {
      expect(validateOrgConfig({ ...form, screenshotRetentionDays: ok })).toEqual({});
    }
    expect(() => buildOrgConfig({ ...form, screenshotRetentionDays: '0' }, 'u', NOW)).toThrow();
  });

  it('validates the domain list: not empty, max 10, valid domains, own domain kept', () => {
    expect(validateOrgConfig({ ...form, allowedDomains: [] }).allowedDomains).toMatch(/al menos un dominio/);
    expect(validateOrgConfig({ ...form, allowedDomains: ['  '] }).allowedDomains).toMatch(/al menos un dominio/);
    const eleven = Array.from({ length: 11 }, (_, i) => `d${i}.cl`);
    expect(validateOrgConfig({ ...form, allowedDomains: eleven }).allowedDomains).toMatch(/máximo 10/);
    expect(validateOrgConfig({ ...form, allowedDomains: ['impulseai.cl', 'no dominio'] }).allowedDomains).toMatch(/no dominio/);
    expect(validateOrgConfig({ ...form, allowedDomains: ['@empresa.cl'] })).toEqual({});
    expect(validateOrgConfig(form, 'lukas@impulseai.cl')).toEqual({});
    expect(validateOrgConfig({ ...form, allowedDomains: ['compratuparcela.cl'] }, 'lukas@impulseai.cl').allowedDomains).toBe(
      'No puedes quitar @impulseai.cl: es el dominio de tu propia cuenta.',
    );
    expect(() => buildOrgConfig({ ...form, allowedDomains: ['compratuparcela.cl'] }, 'u', NOW, 'lukas@impulseai.cl')).toThrow(
      /tu propia cuenta/,
    );
    expect(() => buildOrgConfig({ ...form, allowedDomains: [] }, 'u', NOW)).toThrow();
  });

  it('validateDomainList', () => {
    expect(validateDomainList(['impulseai.cl'])).toBeNull();
    expect(validateDomainList(Array.from({ length: 10 }, (_, i) => `d${i}.cl`))).toBeNull();
    expect(validateDomainList([])).toBeTruthy();
  });

  it('addDomain normalizes and rejects invalid, repeated or too many', () => {
    expect(addDomain(['impulseai.cl'], ' @CompraTuParcela.CL ')).toEqual({
      ok: true,
      domain: 'compratuparcela.cl',
      domains: ['impulseai.cl', 'compratuparcela.cl'],
    });
    expect(addDomain(['impulseai.cl'], '')).toMatchObject({ ok: false });
    expect(addDomain(['impulseai.cl'], 'no dominio')).toMatchObject({ ok: false, error: expect.stringContaining('no es válido') });
    expect(addDomain(['impulseai.cl'], 'a@b.cl')).toMatchObject({ ok: false });
    expect(addDomain(['impulseai.cl'], 'IMPULSEAI.cl')).toEqual({ ok: false, error: '@impulseai.cl ya está en la lista.' });
    const ten = Array.from({ length: 10 }, (_, i) => `d${i}.cl`);
    expect(addDomain(ten, 'otro.cl')).toMatchObject({ ok: false, error: expect.stringContaining('máximo 10') });
  });

  it('canRemoveDomain: never the last one nor the admin own domain', () => {
    const list = ['impulseai.cl', 'compratuparcela.cl'];
    expect(canRemoveDomain(list, 'compratuparcela.cl', 'lukas@impulseai.cl')).toBe(true);
    expect(canRemoveDomain(list, 'impulseai.cl', 'Lukas@ImpulseAI.cl')).toBe(false);
    expect(canRemoveDomain(list, 'impulseai.cl')).toBe(true);
    expect(canRemoveDomain(['compratuparcela.cl'], 'compratuparcela.cl')).toBe(false);
  });

  it('form defaults when config/org does not exist', () => {
    expect(orgConfigToForm(null, ['x.cl', 'y.cl'])).toEqual({
      allowedDomains: ['x.cl', 'y.cl'],
      screenshotsEnabled: false,
      blurScreenshots: true,
      screenshotRetentionDays: '90',
      pauseTimerAtLunch: false,
    });
  });

  it('form tolerates an old config/org with a single allowedDomain', () => {
    const legacy = {
      allowedDomain: 'CompraTuParcela.cl',
      screenshotsEnabled: true,
      blurScreenshots: false,
      screenshotRetentionDays: 30,
      updatedAt: NOW,
      updatedBy: 'x',
    } as unknown as OrgConfig;
    expect(orgConfigToForm(legacy, ['x.cl'])).toEqual({
      allowedDomains: ['compratuparcela.cl'],
      screenshotsEnabled: true,
      blurScreenshots: false,
      screenshotRetentionDays: '30',
      pauseTimerAtLunch: false,
    });
    expect(orgConfigToForm({ ...legacy, pauseTimerAtLunch: true }, ['x.cl']).pauseTimerAtLunch).toBe(true);
  });
});

describe('invitations', () => {
  const inv = (id: string, status: Invitation['status'], extra: Partial<Invitation> = {}): WithId<Invitation> => ({
    id,
    email: id,
    invitedBy: 'other-admin',
    invitedAt: NOW - 1000,
    status,
    ...extra,
  });

  it('checks domain, format, existing users and invitations', () => {
    const invitations = [inv('pendiente@compratuparcela.cl', 'pending'), inv('lista@compratuparcela.cl', 'accepted'), inv('fuera@compratuparcela.cl', 'revoked')];
    const users = [member('ana', 'Ana')];
    const check = (email: string) => checkInvite(email, ['compratuparcela.cl'], invitations, users);
    expect(check('')).toMatchObject({ ok: false });
    expect(check('sin-arroba')).toMatchObject({ ok: false, error: 'El correo no es válido.' });
    expect(check('x@gmail.com')).toMatchObject({ ok: false, error: 'Solo puedes invitar correos @compratuparcela.cl.' });
    expect(check('x@sub.compratuparcela.cl')).toMatchObject({ ok: false });
    expect(check('ANA@compratuparcela.cl')).toMatchObject({ ok: false });
    expect(check('pendiente@compratuparcela.cl')).toMatchObject({ ok: false });
    expect(check('lista@compratuparcela.cl')).toMatchObject({ ok: false });
    expect(check('  Fuera@CompraTuParcela.cl ')).toEqual({ ok: true, id: 'fuera@compratuparcela.cl', email: 'fuera@compratuparcela.cl', mode: 'reinvite' });
    expect(check('Nuevo@compratuparcela.cl')).toEqual({ ok: true, id: 'nuevo@compratuparcela.cl', email: 'nuevo@compratuparcela.cl', mode: 'create' });
  });

  it('accepts emails of any allowed domain (and only those)', () => {
    const check = (email: string) => checkInvite(email, ['impulseai.cl', 'compratuparcela.cl'], [], []);
    expect(check('X@ImpulseAI.cl')).toEqual({ ok: true, id: 'x@impulseai.cl', email: 'x@impulseai.cl', mode: 'create' });
    expect(check('y@compratuparcela.cl')).toMatchObject({ ok: true, id: 'y@compratuparcela.cl' });
    for (const bad of ['z@gmail.com', 'a@sub.impulseai.cl', 'a@evilimpulseai.cl', 'a@impulseai.cl.evil.com']) {
      expect(check(bad)).toEqual({ ok: false, error: 'Solo puedes invitar correos @impulseai.cl o @compratuparcela.cl.' });
    }
  });

  it('new invitation: pending, invitedBy = caller, lowercase email', () => {
    expect(buildInvitation('Nuevo@compratuparcela.cl', 'me', NOW)).toEqual({
      email: 'nuevo@compratuparcela.cl',
      invitedBy: 'me',
      invitedAt: NOW,
      status: 'pending',
    });
  });

  it('resend: back to pending with a newer invitedAt and the caller as invitedBy', () => {
    const r = buildResend(inv('a@compratuparcela.cl', 'revoked', { acceptedAt: NOW - 500 }), 'me', NOW);
    expect(r).toEqual({ email: 'a@compratuparcela.cl', invitedBy: 'me', invitedAt: NOW, status: 'pending' });
    // Same millisecond (or clock behind): invitedAt still changes, so the email is sent.
    const same = buildResend(inv('a@compratuparcela.cl', 'pending', { invitedAt: NOW }), 'me', NOW);
    expect(same.invitedAt).toBe(NOW + 1);
  });

  it('revoke keeps the other fields', () => {
    expect(buildRevoke(inv('a@compratuparcela.cl', 'pending'))).toEqual({
      email: 'a@compratuparcela.cl',
      invitedBy: 'other-admin',
      invitedAt: NOW - 1000,
      status: 'revoked',
    });
  });

  it('sorts pending first, then newest', () => {
    const list = [inv('a', 'accepted', { invitedAt: 3 }), inv('b', 'pending', { invitedAt: 1 }), inv('c', 'pending', { invitedAt: 2 }), inv('d', 'revoked', { invitedAt: 9 })];
    expect(sortInvitations(list).map((i) => i.id)).toEqual(['c', 'b', 'a', 'd']);
  });
});
