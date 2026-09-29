import { describe, expect, it } from 'vitest';
import type { Invitation, WithId } from '@timetracking/shared';
import {
  buildInvitation,
  buildOrgConfig,
  buildResend,
  buildRevoke,
  checkInvite,
  orgConfigToForm,
  sortInvitations,
  validateOrgConfig,
} from '../src/lib/payloads';
import { member } from './fakes';

const NOW = 1_790_000_000_000;

describe('org config', () => {
  const form = { allowedDomain: ' CompraTuParcela.cl ', screenshotsEnabled: true, blurScreenshots: false, screenshotRetentionDays: '30' };

  it('builds exactly the 6 fields the rules require', () => {
    const cfg = buildOrgConfig(form, 'uid-admin', NOW + 0.7);
    expect(cfg).toEqual({
      allowedDomain: 'compratuparcela.cl',
      screenshotsEnabled: true,
      blurScreenshots: false,
      screenshotRetentionDays: 30,
      updatedAt: NOW,
      updatedBy: 'uid-admin',
    });
    expect(Object.keys(cfg).sort()).toEqual(
      ['allowedDomain', 'blurScreenshots', 'screenshotRetentionDays', 'screenshotsEnabled', 'updatedAt', 'updatedBy'],
    );
    expect(Number.isInteger(cfg.updatedAt)).toBe(true);
  });

  it('validates retention (integer 1..3650) and domain', () => {
    for (const bad of ['0', '3651', '1.5', '', 'abc', '-3']) {
      expect(validateOrgConfig({ ...form, screenshotRetentionDays: bad }).screenshotRetentionDays).toBeTruthy();
    }
    for (const ok of ['1', '90', '3650']) {
      expect(validateOrgConfig({ ...form, screenshotRetentionDays: ok })).toEqual({});
    }
    expect(validateOrgConfig({ ...form, allowedDomain: '' }).allowedDomain).toBeTruthy();
    expect(validateOrgConfig({ ...form, allowedDomain: 'no dominio' }).allowedDomain).toBeTruthy();
    expect(validateOrgConfig({ ...form, allowedDomain: '@empresa.cl' })).toEqual({});
    expect(() => buildOrgConfig({ ...form, screenshotRetentionDays: '0' }, 'u', NOW)).toThrow();
  });

  it('form defaults when config/org does not exist', () => {
    expect(orgConfigToForm(null, 'x.cl')).toEqual({
      allowedDomain: 'x.cl',
      screenshotsEnabled: false,
      blurScreenshots: true,
      screenshotRetentionDays: '90',
    });
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
    const check = (email: string) => checkInvite(email, 'compratuparcela.cl', invitations, users);
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
