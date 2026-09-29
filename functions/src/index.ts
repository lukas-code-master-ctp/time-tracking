/**
 * Cloud Functions entry point (spec section 6). Handlers are thin wrappers
 * around the pure/injectable logic in `./core`.
 *
 * Configuration:
 * - Env (`functions/.env*`): `ALLOWED_DOMAIN` (comma separated list; fallback
 *   when `config/org` does not exist; default from shared), `BOOTSTRAP_ADMINS` (comma separated).
 *   Read from `process.env` on purpose: string params without a value would
 *   make the CLI prompt (and block `emulators:exec`).
 * - Param `EXTENSION_INSTALL_URL` (has a default, so it never prompts).
 * - Env `INVITE_EMAIL_ENABLED` (`true`/`false`, default `false`): invitation
 *   email is opt-in. Read at module load (the CLI loads `.env` before the
 *   deploy analysis). When not `true`, no secret is declared and the email is
 *   only logged (recipient and subject).
 * - Secrets `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
 *   (Secret Manager), declared only with `INVITE_EMAIL_ENABLED=true`. Only
 *   `onInvitationWritten` binds them, and never in the emulator (which only
 *   logs the email).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import nodemailer from 'nodemailer';
import {
  COLLECTIONS,
  DEFAULT_TIME_ZONE,
  FUNCTIONS_REGION,
  SCHEDULER_REGION,
  emailKey,
  resolveConfig,
  type Invitation,
} from '@timetracking/shared';
import { joinOrgCore } from './core/join.js';
import {
  SMTP_SECRET_NAMES,
  buildInvitationEmail,
  deliverEmail,
  isInviteEmailEnabled,
  resolveSmtpConfig,
  shouldBindSmtpSecrets,
  shouldDeclareSmtpSecrets,
  shouldSendInvitationEmail,
  type SendMail,
  type SmtpSecretName,
} from './core/invitationEmail.js';
import { purgeOldScreenshotsCore } from './core/purge.js';
import { autoCloseStaleSessionsCore } from './core/autoClose.js';

initializeApp();
setGlobalOptions({ region: FUNCTIONS_REGION, maxInstances: 10 });

const EXTENSION_INSTALL_URL = defineString('EXTENSION_INSTALL_URL', {
  default: 'https://chromewebstore.google.com/',
  description: 'Enlace de instalación de la extensión de Chrome incluido en el correo de invitación.',
});

const isEmulator = (): boolean => process.env.FUNCTIONS_EMULATOR === 'true';

/** Decided once at module load (the CLI loads `functions/.env.<project>` before analysing for deploy). */
const INVITE_EMAIL_ENABLED = isInviteEmailEnabled(process.env);

// When email is disabled the secrets are not declared at all, so `firebase deploy`
// does not require them in Secret Manager.
const SMTP_SECRETS = shouldDeclareSmtpSecrets({ emailEnabled: INVITE_EMAIL_ENABLED })
  ? (Object.fromEntries(SMTP_SECRET_NAMES.map((name) => [name, defineSecret(name)])) as Record<
      SmtpSecretName,
      ReturnType<typeof defineSecret>
    >)
  : null;

/** Secret value, or undefined when it is not available (disabled, or emulator without `.secret.local`). */
function secretValue(name: SmtpSecretName): string | undefined {
  if (!SMTP_SECRETS) return undefined;
  try {
    const v = SMTP_SECRETS[name].value();
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}


// ---------- joinOrg ----------

export const joinOrg = onCall(async (request) => {
  const auth = request.auth;
  const token = auth?.token;
  const config = resolveConfig(process.env);
  const { profile } = await joinOrgCore(
    {
      db: getFirestore(),
      now: Date.now(),
      fallbackAllowedDomains: config.allowedDomains,
      bootstrapAdmins: config.bootstrapAdmins,
    },
    auth
      ? {
          uid: auth.uid,
          email: token?.email,
          emailVerified: token?.email_verified,
          displayName: typeof token?.name === 'string' ? token.name : undefined,
          photoURL: token?.picture,
        }
      : null,
  );
  return { profile };
});

// ---------- onInvitationWritten ----------

const sendMail: SendMail = async (smtp, message) => {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  await transport.sendMail({
    from: smtp.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
};

export const onInvitationWritten = onDocumentWritten(
  {
    document: `${COLLECTIONS.invitations}/{invitationId}`,
    // Bound only when email is enabled and outside the emulator. The emulator never
    // sends, and binding would make it read them from Secret Manager (or ask for
    // `.secret.local`) on every invocation. Deploy/discovery runs without
    // FUNCTIONS_EMULATOR and binds them only with INVITE_EMAIL_ENABLED=true.
    // The function stays deployed when email is off: it just logs, so enabling
    // email later is only changing the variable and deploying again.
    secrets:
      SMTP_SECRETS && shouldBindSmtpSecrets({ emailEnabled: INVITE_EMAIL_ENABLED, isEmulator: isEmulator() })
        ? Object.values(SMTP_SECRETS)
        : [],
  },
  async (event) => {
    const before = event.data?.before.data() as Invitation | undefined;
    const after = event.data?.after.data() as Invitation | undefined;
    if (!shouldSendInvitationEmail(before, after)) return;

    const to = emailKey(after?.email ?? event.params.invitationId);
    const message = buildInvitationEmail({ to, installUrl: EXTENSION_INSTALL_URL.value() });
    await deliverEmail({
      message,
      smtp: isEmulator() || !INVITE_EMAIL_ENABLED ? null : resolveSmtpConfig(secretValue),
      isEmulator: isEmulator(),
      emailEnabled: INVITE_EMAIL_ENABLED,
      sendMail,
      logger,
    });
  },
);

// ---------- scheduled jobs ----------

export const purgeOldScreenshots = onSchedule(
  { schedule: 'every day 03:00', timeZone: DEFAULT_TIME_ZONE, timeoutSeconds: 540, region: SCHEDULER_REGION },
  async () => {
    const result = await purgeOldScreenshotsCore({
      db: getFirestore(),
      bucket: getStorage().bucket(),
      now: Date.now(),
      logger,
    });
    logger.info('Purga de capturas terminada', result);
  },
);

export const autoCloseStaleSessions = onSchedule(
  { schedule: 'every 1 hours', timeZone: DEFAULT_TIME_ZONE, region: SCHEDULER_REGION },
  async () => {
    const result = await autoCloseStaleSessionsCore({ db: getFirestore(), now: Date.now(), logger });
    logger.info('Cierre automático de jornadas terminado', {
      closed: result.closed.length,
      conflicts: result.conflicts.length,
    });
  },
);
