/**
 * Invitation email (spec section 6, `onInvitationWritten`): when to send it,
 * what it says and how it is delivered. Pure / injectable for tests.
 */
import type { Invitation } from '@timetracking/shared';

/**
 * An email is sent when an invitation becomes pending:
 * - it is created with status `pending`, or
 * - it changes from another status (`revoked`, `accepted`) to `pending` (re-invite), or
 * - it stays `pending` but `invitedAt` changes (the admin pressed "re-send").
 * Deletions and any other change send nothing.
 */
export function shouldSendInvitationEmail(
  before: Partial<Invitation> | undefined,
  after: Partial<Invitation> | undefined,
): boolean {
  if (!after || after.status !== 'pending') return false;
  if (!before) return true;
  if (before.status !== 'pending') return true;
  return before.invitedAt !== after.invitedAt;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildInvitationEmail(params: { to: string; installUrl: string }): EmailMessage {
  const { to, installUrl } = params;
  const subject = 'Invitación al registro de jornada';
  const text = [
    'Hola:',
    '',
    'Te invitaron a usar el registro de jornada de la empresa.',
    '',
    'Para empezar:',
    `1. Instala la extensión de Chrome desde este enlace: ${installUrl}`,
    `2. Abre la extensión e inicia sesión con tu cuenta Google de la empresa (${to}).`,
    '3. Lee y acepta el aviso que explica qué se mide y qué no.',
    '4. Presiona "Iniciar jornada" al comenzar a trabajar y "Cerrar jornada" al terminar.',
    '',
    'Solo se mide mientras tienes la jornada iniciada.',
    '',
    'Si no esperabas este correo, puedes ignorarlo.',
  ].join('\n');

  const safeTo = escapeHtml(to);
  const safeUrl = escapeHtml(installUrl);
  const html = `<!doctype html>
<html lang="es">
<body style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.5;">
  <p>Hola:</p>
  <p>Te invitaron a usar el <strong>registro de jornada</strong> de la empresa.</p>
  <p>Para empezar:</p>
  <ol>
    <li>Instala la extensión de Chrome: <a href="${safeUrl}">${safeUrl}</a></li>
    <li>Abre la extensión e inicia sesión con tu cuenta Google de la empresa (<strong>${safeTo}</strong>).</li>
    <li>Lee y acepta el aviso que explica qué se mide y qué no.</li>
    <li>Presiona <em>Iniciar jornada</em> al comenzar a trabajar y <em>Cerrar jornada</em> al terminar.</li>
  </ol>
  <p>Solo se mide mientras tienes la jornada iniciada.</p>
  <p style="color: #6b7280; font-size: 12px;">Si no esperabas este correo, puedes ignorarlo.</p>
</body>
</html>`;
  return { to, subject, text, html };
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export const SMTP_SECRET_NAMES = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;
export type SmtpSecretName = (typeof SMTP_SECRET_NAMES)[number];

/** Returns null when any value is missing or the port is invalid. */
export function resolveSmtpConfig(
  get: (name: SmtpSecretName) => string | undefined,
): SmtpConfig | null {
  const values: Partial<Record<SmtpSecretName, string>> = {};
  for (const name of SMTP_SECRET_NAMES) {
    const v = get(name)?.trim();
    if (!v) return null;
    values[name] = v;
  }
  const port = Number(values.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return {
    host: values.SMTP_HOST!,
    port,
    secure: port === 465,
    user: values.SMTP_USER!,
    pass: values.SMTP_PASS!,
    from: values.SMTP_FROM!,
  };
}

/**
 * Invitation email is opt-in: `INVITE_EMAIL_ENABLED=true` in `functions/.env.<project>`.
 * Any other value (or none) disables it. Read from `process.env` at module
 * load: the Firebase CLI loads the `.env` files before analysing the functions
 * for deploy, so the decision also shapes what the deploy declares.
 */
export function isInviteEmailEnabled(env: Record<string, string | undefined>): boolean {
  return env.INVITE_EMAIL_ENABLED?.trim().toLowerCase() === 'true';
}

/** Whether the SMTP secrets are declared at all (`defineSecret`). `firebase deploy` requires every declared secret. */
export function shouldDeclareSmtpSecrets(params: { emailEnabled: boolean }): boolean {
  return params.emailEnabled;
}

/**
 * Whether `onInvitationWritten` binds the SMTP secrets: only when email is
 * enabled and we are not in the emulator (which never sends, and binding would
 * make it read them from Secret Manager or `.secret.local` on every call).
 */
export function shouldBindSmtpSecrets(params: { emailEnabled: boolean; isEmulator: boolean }): boolean {
  return shouldDeclareSmtpSecrets(params) && !params.isEmulator;
}

export type SendMail = (smtp: SmtpConfig, message: EmailMessage) => Promise<void>;

export interface LoggerLike {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export type DeliveryResult = 'sent' | 'logged';

/**
 * Sends the message with SMTP, or only logs it: in the emulator (recipient,
 * subject and body), when email is disabled (recipient and subject only) or
 * when SMTP is not configured. Never throws for missing configuration; SMTP
 * errors propagate so the trigger reports them.
 */
export async function deliverEmail(params: {
  message: EmailMessage;
  smtp: SmtpConfig | null;
  isEmulator: boolean;
  emailEnabled: boolean;
  sendMail: SendMail;
  logger: LoggerLike;
}): Promise<DeliveryResult> {
  const { message, smtp, isEmulator, emailEnabled, sendMail, logger } = params;
  if (!isEmulator && !emailEnabled) {
    logger.info('Correo de invitación desactivado (INVITE_EMAIL_ENABLED no es true), no se envía', {
      to: message.to,
      subject: message.subject,
    });
    return 'logged';
  }
  if (isEmulator || !smtp) {
    logger.info(
      isEmulator
        ? 'Correo de invitación (emulador, no se envía)'
        : 'Correo de invitación (SMTP no configurado, no se envía)',
      { to: message.to, subject: message.subject, text: message.text },
    );
    return 'logged';
  }
  await sendMail(smtp, message);
  logger.info('Correo de invitación enviado', { to: message.to, subject: message.subject });
  return 'sent';
}
