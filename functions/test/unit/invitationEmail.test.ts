import { describe, expect, it, vi } from 'vitest';
import type { Invitation } from '@timetracking/shared';
import {
  buildInvitationEmail,
  deliverEmail,
  isInviteEmailEnabled,
  resolveSmtpConfig,
  shouldBindSmtpSecrets,
  shouldDeclareSmtpSecrets,
  shouldSendInvitationEmail,
  type SmtpConfig,
} from '../../src/core/invitationEmail.js';

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

describe('resolveSmtpConfig', () => {
  const full: Record<string, string> = {
    SMTP_HOST: 'smtp.test',
    SMTP_PORT: '465',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    SMTP_FROM: 'From <f@t.cl>',
  };
  const withValues = (values: Record<string, string | undefined>) => (n: string) => values[n];

  it('builds the config when every value is present', () => {
    expect(resolveSmtpConfig(withValues(full))).toEqual({
      host: 'smtp.test',
      port: 465,
      secure: true,
      user: 'u',
      pass: 'p',
      from: 'From <f@t.cl>',
    });
    expect(resolveSmtpConfig(withValues({ ...full, SMTP_PORT: '587' }))?.secure).toBe(false);
  });

  it('returns null when a value is missing, blank or the port is invalid', () => {
    for (const name of Object.keys(full)) {
      expect(resolveSmtpConfig(withValues({ ...full, [name]: undefined }))).toBeNull();
      expect(resolveSmtpConfig(withValues({ ...full, [name]: '  ' }))).toBeNull();
    }
    expect(resolveSmtpConfig(withValues({ ...full, SMTP_PORT: 'abc' }))).toBeNull();
    expect(resolveSmtpConfig(withValues({ ...full, SMTP_PORT: '70000' }))).toBeNull();
  });
});

describe('isInviteEmailEnabled', () => {
  it('is enabled only with INVITE_EMAIL_ENABLED=true', () => {
    expect(isInviteEmailEnabled({ INVITE_EMAIL_ENABLED: 'true' })).toBe(true);
    expect(isInviteEmailEnabled({ INVITE_EMAIL_ENABLED: ' TRUE ' })).toBe(true);
  });

  it('defaults to disabled (missing, empty, false or anything else)', () => {
    expect(isInviteEmailEnabled({})).toBe(false);
    expect(isInviteEmailEnabled({ INVITE_EMAIL_ENABLED: '' })).toBe(false);
    expect(isInviteEmailEnabled({ INVITE_EMAIL_ENABLED: 'false' })).toBe(false);
    expect(isInviteEmailEnabled({ INVITE_EMAIL_ENABLED: '1' })).toBe(false);
    expect(isInviteEmailEnabled({ INVITE_EMAIL_ENABLED: 'yes' })).toBe(false);
  });
});

describe('SMTP secrets declaration and binding', () => {
  it('declares no secret when email is disabled, so deploy does not require them', () => {
    expect(shouldDeclareSmtpSecrets({ emailEnabled: false })).toBe(false);
    expect(shouldBindSmtpSecrets({ emailEnabled: false, isEmulator: false })).toBe(false);
    expect(shouldBindSmtpSecrets({ emailEnabled: false, isEmulator: true })).toBe(false);
  });

  it('declares and binds them when email is enabled (deploy)', () => {
    expect(shouldDeclareSmtpSecrets({ emailEnabled: true })).toBe(true);
    expect(shouldBindSmtpSecrets({ emailEnabled: true, isEmulator: false })).toBe(true);
  });

  it('never binds them in the emulator', () => {
    expect(shouldBindSmtpSecrets({ emailEnabled: true, isEmulator: true })).toBe(false);
  });
});

describe('deliverEmail', () => {
  const message = buildInvitationEmail({ to: 'x@compratuparcela.cl', installUrl: 'https://e.test' });
  const smtp: SmtpConfig = { host: 'h', port: 465, secure: true, user: 'u', pass: 'p', from: 'f@t.cl' };
  const makeLogger = () => ({ info: vi.fn(), warn: vi.fn() });

  it('only logs recipient, subject and body in the emulator', async () => {
    const sendMail = vi.fn();
    const logger = makeLogger();
    await expect(deliverEmail({ message, smtp, isEmulator: true, emailEnabled: true, sendMail, logger })).resolves.toBe('logged');
    expect(sendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), {
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  });

  it('only logs when SMTP is not configured', async () => {
    const sendMail = vi.fn();
    const logger = makeLogger();
    await expect(deliverEmail({ message, smtp: null, isEmulator: false, emailEnabled: true, sendMail, logger })).resolves.toBe(
      'logged',
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends with SMTP when configured', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    await expect(deliverEmail({ message, smtp, isEmulator: false, emailEnabled: true, sendMail, logger })).resolves.toBe('sent');
    expect(sendMail).toHaveBeenCalledWith(smtp, message);
  });

  it('only logs recipient and subject (no body) when email is disabled, even with SMTP', async () => {
    const sendMail = vi.fn();
    const logger = makeLogger();
    await expect(
      deliverEmail({ message, smtp, isEmulator: false, emailEnabled: false, sendMail, logger }),
    ).resolves.toBe('logged');
    expect(sendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/desactivado/), {
      to: message.to,
      subject: message.subject,
    });
  });

  it('keeps the emulator behavior (logs the body) when email is disabled', async () => {
    const sendMail = vi.fn();
    const logger = makeLogger();
    await expect(
      deliverEmail({ message, smtp: null, isEmulator: true, emailEnabled: false, sendMail, logger }),
    ).resolves.toBe('logged');
    expect(sendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/emulador/), {
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  });
});
