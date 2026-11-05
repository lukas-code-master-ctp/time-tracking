import { describe, expect, it, vi } from 'vitest';
import type { Invitation } from '@timetracking/shared';
import { buildInvitationEmail, shouldSendInvitationEmail } from '../../src/core/invitationEmail.js';
import {
  deliverEmail,
  emailFrom,
  isEmailEnabled,
  resendSender,
  shouldBindEmailSecret,
  shouldDeclareEmailSecret,
  type ResendConfig,
} from '../../src/core/email.js';

const inv = (overrides: Partial<Invitation> = {}): Invitation => ({
  email: 'x@compratuparcela.cl',
  invitedBy: 'admin',
  invitedAt: 1000,
  status: 'pending',
  ...overrides,
});

describe('shouldSendInvitationEmail', () => {
  it('sends when an invitation is created pending', () => {
    expect(shouldSendInvitationEmail(undefined, inv())).toBe(true);
  });

  it('does not send when created with another status', () => {
    expect(shouldSendInvitationEmail(undefined, inv({ status: 'accepted' }))).toBe(false);
    expect(shouldSendInvitationEmail(undefined, inv({ status: 'revoked' }))).toBe(false);
  });

  it('sends when re-invited (revoked/accepted -> pending)', () => {
    expect(shouldSendInvitationEmail(inv({ status: 'revoked' }), inv({ invitedAt: 2000 }))).toBe(true);
    expect(shouldSendInvitationEmail(inv({ status: 'accepted' }), inv())).toBe(true);
  });

  it('sends again when a pending invitation gets a new invitedAt (re-send)', () => {
    expect(shouldSendInvitationEmail(inv(), inv({ invitedAt: 2000 }))).toBe(true);
  });

  it('does not send on unrelated updates, acceptance, revocation or deletion', () => {
    expect(shouldSendInvitationEmail(inv(), inv())).toBe(false);
    expect(shouldSendInvitationEmail(inv(), inv({ status: 'accepted', acceptedAt: 5 }))).toBe(false);
    expect(shouldSendInvitationEmail(inv(), inv({ status: 'revoked' }))).toBe(false);
    expect(shouldSendInvitationEmail(inv(), undefined)).toBe(false);
    expect(shouldSendInvitationEmail(undefined, undefined)).toBe(false);
  });
});

describe('buildInvitationEmail', () => {
  it('is in Spanish, has text and HTML, and explains install + Google login', () => {
    const m = buildInvitationEmail({ to: 'x@compratuparcela.cl', installUrl: 'https://example.test/ext' });
    expect(m.to).toBe('x@compratuparcela.cl');
    expect(m.subject).toMatch(/Invitación/);
    for (const body of [m.text, m.html]) {
      expect(body).toContain('https://example.test/ext');
      expect(body).toContain('x@compratuparcela.cl');
      expect(body).toMatch(/extensión de Chrome/);
      expect(body).toMatch(/cuenta Google de la empresa/);
    }
    expect(m.html).toContain('<a href="https://example.test/ext">');
  });

  it('escapes HTML in interpolated values', () => {
    const m = buildInvitationEmail({ to: 'a@b.cl', installUrl: 'https://e.test/?a=1&b="<x>"' });
    expect(m.html).not.toContain('"<x>"');
    expect(m.html).toContain('&amp;b=&quot;&lt;x&gt;&quot;');
  });
});

describe('isEmailEnabled / emailFrom', () => {
  it('is enabled only with EMAIL_ENABLED=true (or the older INVITE_EMAIL_ENABLED=true)', () => {
    expect(isEmailEnabled({ EMAIL_ENABLED: 'true' })).toBe(true);
    expect(isEmailEnabled({ EMAIL_ENABLED: ' TRUE ' })).toBe(true);
    expect(isEmailEnabled({ INVITE_EMAIL_ENABLED: 'true' })).toBe(true);
  });

  it('defaults to disabled (missing, empty, false or anything else)', () => {
    expect(isEmailEnabled({})).toBe(false);
    expect(isEmailEnabled({ EMAIL_ENABLED: '' })).toBe(false);
    expect(isEmailEnabled({ EMAIL_ENABLED: 'false', INVITE_EMAIL_ENABLED: 'false' })).toBe(false);
    expect(isEmailEnabled({ EMAIL_ENABLED: '1' })).toBe(false);
  });

  it('reads the sender', () => {
    expect(emailFrom({ EMAIL_FROM: ' Registro <a@b.cl> ' })).toBe('Registro <a@b.cl>');
    expect(emailFrom({})).toBeNull();
  });
});

describe('Resend secret declaration and binding', () => {
  it('declares no secret when email is disabled, so deploy does not require it', () => {
    expect(shouldDeclareEmailSecret({ emailEnabled: false })).toBe(false);
    expect(shouldBindEmailSecret({ emailEnabled: false, isEmulator: false })).toBe(false);
  });

  it('declares and binds it when enabled, never in the emulator', () => {
    expect(shouldDeclareEmailSecret({ emailEnabled: true })).toBe(true);
    expect(shouldBindEmailSecret({ emailEnabled: true, isEmulator: false })).toBe(true);
    expect(shouldBindEmailSecret({ emailEnabled: true, isEmulator: true })).toBe(false);
  });
});

describe('resendSender', () => {
  const config: ResendConfig = { apiKey: 're_test', from: 'Registro <no-responder@compratuparcela.cl>' };
  const message = { to: 'x@compratuparcela.cl', subject: 'S', text: 'T', html: '<p>H</p>' };

  it('posts the email to the Resend API', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"id":"1"}' });
    await resendSender(fetchFn)(config, message);
    expect(fetchFn).toHaveBeenCalledWith('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer re_test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.from, to: ['x@compratuparcela.cl'], subject: 'S', text: 'T', html: '<p>H</p>' }),
    });
  });

  it('throws with the status on errors', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'domain not verified' });
    await expect(resendSender(fetchFn)(config, message)).rejects.toThrow(/403: domain not verified/);
  });
});

describe('deliverEmail', () => {
  const message = buildInvitationEmail({ to: 'x@compratuparcela.cl', installUrl: 'https://e.test' });
  const config: ResendConfig = { apiKey: 'k', from: 'f@t.cl' };
  const makeLogger = () => ({ info: vi.fn(), warn: vi.fn() });
  const label = 'Correo de invitación';

  it('only logs recipient, subject and body in the emulator', async () => {
    const send = vi.fn();
    const logger = makeLogger();
    await expect(deliverEmail({ label, message, config, isEmulator: true, emailEnabled: true, send, logger })).resolves.toBe('logged');
    expect(send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/emulador/), { to: message.to, subject: message.subject, text: message.text });
  });

  it('only logs when Resend is not configured', async () => {
    const send = vi.fn();
    await expect(
      deliverEmail({ label, message, config: null, isEmulator: false, emailEnabled: true, send, logger: makeLogger() }),
    ).resolves.toBe('logged');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends when configured', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await expect(deliverEmail({ label, message, config, isEmulator: false, emailEnabled: true, send, logger: makeLogger() })).resolves.toBe('sent');
    expect(send).toHaveBeenCalledWith(config, message);
  });

  it('only logs recipient and subject (no body) when email is disabled', async () => {
    const send = vi.fn();
    const logger = makeLogger();
    await expect(deliverEmail({ label, message, config, isEmulator: false, emailEnabled: false, send, logger })).resolves.toBe('logged');
    expect(send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/desactivado/), { to: message.to, subject: message.subject });
  });
});
