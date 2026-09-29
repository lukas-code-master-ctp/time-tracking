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
 * - Secrets `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
 *   (Secret Manager). Only `onInvitationWritten` binds them. In the emulator
 *   they come from `functions/.secret.local` if present; when missing the
 *   email is only logged.
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
  emailKey,
  resolveConfig,
  type Invitation,
} from '@timetracking/shared';
import { joinOrgCore } from './core/join.js';
import {
  SMTP_SECRET_NAMES,
  buildInvitationEmail,
  deliverEmail,
  resolveSmtpConfig,
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

const SMTP_SECRETS = Object.fromEntries(
  SMTP_SECRET_NAMES.map((name) => [name, defineSecret(name)]),
) as Record<SmtpSecretName, ReturnType<typeof defineSecret>>;

/** Secret value, or undefined when it is not available (e.g. emulator without `.secret.local`). */
function secretValue(name: SmtpSecretName): string | undefined {
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
    // The emulator never sends email, so it does not bind the secrets: otherwise it
    // tries to read them from Secret Manager (or asks for `.secret.local`) on
    // every invocation. Deploy/discovery runs without FUNCTIONS_EMULATOR and binds them.
    secrets: isEmulator() ? [] : Object.values(SMTP_SECRETS),
  },
  async (event) => {
    const before = event.data?.before.data() as Invitation | undefined;
    const after = event.data?.after.data() as Invitation | undefined;
    if (!shouldSendInvitationEmail(before, after)) return;

    const to = emailKey(after?.email ?? event.params.invitationId);
    const message = buildInvitationEmail({ to, installUrl: EXTENSION_INSTALL_URL.value() });
    await deliverEmail({
      message,
      smtp: isEmulator() ? null : resolveSmtpConfig(secretValue),
      isEmulator: isEmulator(),
      sendMail,
      logger,
    });
  },
);

// ---------- scheduled jobs ----------

export const purgeOldScreenshots = onSchedule(
  { schedule: 'every day 03:00', timeZone: DEFAULT_TIME_ZONE, timeoutSeconds: 540 },
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
  { schedule: 'every 1 hours', timeZone: DEFAULT_TIME_ZONE },
  async () => {
    const result = await autoCloseStaleSessionsCore({ db: getFirestore(), now: Date.now(), logger });
    logger.info('Cierre automático de jornadas terminado', {
      closed: result.closed.length,
      conflicts: result.conflicts.length,
    });
  },
);
