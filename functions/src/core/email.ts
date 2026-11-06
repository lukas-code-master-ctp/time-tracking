/**
 * Email delivery with Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Used by the invitation email and the weekly birthdays digest. Pure /
 * injectable for tests.
 *
 * Configuration (functions/.env.<project>):
 * - `EMAIL_ENABLED=true` turns email on (the old `INVITE_EMAIL_ENABLED=true`
 *   still works). Otherwise nothing is sent and no secret is declared, so
 *   `firebase deploy` does not ask for it.
 * - `EMAIL_FROM`: sender on a domain verified in Resend, e.g.
 *   `Mi Pega HR <notificaciones@mipegahr.cl>`.
 * - Secret `RESEND_API_KEY` (Secret Manager), declared only when email is on.
 */

export interface EmailMessage {
  /** One address, or several (one email with every recipient in `to`). */
  to: string | string[];
  subject: string;
  text: string;
  html: string;
}

export const RESEND_API_URL = 'https://api.resend.com/emails';
export const RESEND_SECRET_NAME = 'RESEND_API_KEY';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Email is opt-in: `EMAIL_ENABLED=true` (or the older `INVITE_EMAIL_ENABLED=true`). */
export function isEmailEnabled(env: Record<string, string | undefined>): boolean {
  const on = (v: string | undefined): boolean => v?.trim().toLowerCase() === 'true';
  return on(env.EMAIL_ENABLED) || on(env.INVITE_EMAIL_ENABLED);
}

/** Sender from `EMAIL_FROM`; null when missing. */
export function emailFrom(env: Record<string, string | undefined>): string | null {
  const v = env.EMAIL_FROM?.trim();
  return v ? v : null;
}

/** Whether the Resend secret is declared at all: `firebase deploy` requires every declared secret. */
export function shouldDeclareEmailSecret(params: { emailEnabled: boolean }): boolean {
  return params.emailEnabled;
}

/** Bound only when declared and outside the emulator (which never sends). */
export function shouldBindEmailSecret(params: { emailEnabled: boolean; isEmulator: boolean }): boolean {
  return shouldDeclareEmailSecret(params) && !params.isEmulator;
}

export interface ResendConfig {
  apiKey: string;
  from: string;
}

export type SendEmail = (config: ResendConfig, message: EmailMessage) => Promise<void>;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Sends with the Resend HTTP API. Throws with the status and Resend's message on failure. */
export function resendSender(fetchFn: FetchLike = fetch as unknown as FetchLike): SendEmail {
  return async (config, message) => {
    const res = await fetchFn(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.from,
        to: Array.isArray(message.to) ? message.to : [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Resend respondió ${res.status}: ${detail}`);
    }
  };
}

export interface LoggerLike {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export type DeliveryResult = 'sent' | 'logged';

/**
 * Sends the message with Resend, or only logs it: in the emulator
 * (recipient, subject and body), when email is disabled (recipient and
 * subject only) or when Resend is not configured. Never throws for missing
 * configuration; Resend errors propagate so the function reports them.
 * `label` names the email in the logs ("Correo de invitación").
 */
export async function deliverEmail(params: {
  label: string;
  message: EmailMessage;
  config: ResendConfig | null;
  isEmulator: boolean;
  emailEnabled: boolean;
  send: SendEmail;
  logger: LoggerLike;
}): Promise<DeliveryResult> {
  const { label, message, config, isEmulator, emailEnabled, send, logger } = params;
  if (!isEmulator && !emailEnabled) {
    logger.info(`${label} desactivado (EMAIL_ENABLED no es true), no se envía`, { to: message.to, subject: message.subject });
    return 'logged';
  }
  if (isEmulator || !config) {
    logger.info(
      isEmulator ? `${label} (emulador, no se envía)` : `${label} (falta RESEND_API_KEY o EMAIL_FROM, no se envía)`,
      { to: message.to, subject: message.subject, text: message.text },
    );
    return 'logged';
  }
  await send(config, message);
  logger.info(`${label} enviado`, { to: message.to, subject: message.subject });
  return 'sent';
}
