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
 * - Email (Resend, see core/email.ts): env `EMAIL_ENABLED` (`true`/`false`,
 *   default `false`; the older `INVITE_EMAIL_ENABLED` also works) and
 *   `EMAIL_FROM` (sender on a domain verified in Resend), secret
 *   `RESEND_API_KEY` declared only when enabled and bound only outside the
 *   emulator (which only logs). Used by `onInvitationWritten` and
 *   `weeklyCelebrationsDigest`.
 * - Env `PORTAL_URL` (optional): link to the portal in the weekly digest.
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
import {
  COLLECTIONS,
  DEFAULT_TIME_ZONE,
  FUNCTIONS_REGION,
  SCHEDULER_REGION,
  emailKey,
  resolveConfig,
  dateKey,
  type Invitation,
} from '@timetracking/shared';
import { joinOrgCore } from './core/join.js';
import { buildInvitationEmail, shouldSendInvitationEmail } from './core/invitationEmail.js';
import {
  RESEND_SECRET_NAME,
  deliverEmail,
  emailFrom,
  isEmailEnabled,
  resendSender,
  shouldBindEmailSecret,
  shouldDeclareEmailSecret,
  type ResendConfig,
} from './core/email.js';
import { sendCelebrationsDigestCore } from './core/celebrationsDigest.js';
import { purgeOldScreenshotsCore } from './core/purge.js';
import { autoCloseStaleSessionsCore } from './core/autoClose.js';
import { kioskPunchCore } from './core/kiosk.js';

initializeApp();
setGlobalOptions({ region: FUNCTIONS_REGION, maxInstances: 10 });

const EXTENSION_INSTALL_URL = defineString('EXTENSION_INSTALL_URL', {
  default: 'https://chromewebstore.google.com/',
  description: 'Enlace de instalación de la extensión de Chrome incluido en el correo de invitación.',
});

const isEmulator = (): boolean => process.env.FUNCTIONS_EMULATOR === 'true';

/** Decided once at module load (the CLI loads `functions/.env.<project>` before analysing for deploy). */
const EMAIL_ENABLED = isEmailEnabled(process.env);

// When email is disabled the secret is not declared at all, so `firebase deploy`
// does not require it in Secret Manager.
const RESEND_API_KEY = shouldDeclareEmailSecret({ emailEnabled: EMAIL_ENABLED }) ? defineSecret(RESEND_SECRET_NAME) : null;

/** Secrets bound by the functions that send email (none when disabled or in the emulator). */
const EMAIL_SECRETS = RESEND_API_KEY && shouldBindEmailSecret({ emailEnabled: EMAIL_ENABLED, isEmulator: isEmulator() }) ? [RESEND_API_KEY] : [];

/** Resend settings, or null when something is missing (then the email is only logged). */
function resendConfig(): ResendConfig | null {
  if (!RESEND_API_KEY || isEmulator()) return null;
  let apiKey: string | undefined;
  try {
    apiKey = RESEND_API_KEY.value().trim() || undefined;
  } catch {
    apiKey = undefined;
  }
  const from = emailFrom(process.env);
  return apiKey && from ? { apiKey, from } : null;
}

const sendEmail = resendSender();

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

// ---------- kioskPunch ----------

// Spec 2026-11-10-marcaciones: the attendance kiosk (portal /marcar, no
// sign-in) marks entry or exit with a RUT. The device is authorized by its
// secret token (`kiosks/{sha256}`), checked in the core.
export const kioskPunch = onCall(async (request) => {
  return kioskPunchCore({ db: getFirestore(), now: Date.now(), bucket: getStorage().bucket() }, request.data);
});

// ---------- onInvitationWritten ----------

export const onInvitationWritten = onDocumentWritten(
  {
    document: `${COLLECTIONS.invitations}/{invitationId}`,
    // Bound only when email is enabled and outside the emulator. The emulator never
    // sends, and binding would make it read them from Secret Manager (or ask for
    // `.secret.local`) on every invocation. Deploy/discovery runs without
    // FUNCTIONS_EMULATOR and binds it only with EMAIL_ENABLED=true.
    // The function stays deployed when email is off: it just logs, so enabling
    // email later is only changing the variable and deploying again.
    secrets: EMAIL_SECRETS,
  },
  async (event) => {
    const before = event.data?.before.data() as Invitation | undefined;
    const after = event.data?.after.data() as Invitation | undefined;
    if (!shouldSendInvitationEmail(before, after)) return;

    const to = emailKey(after?.email ?? event.params.invitationId);
    const message = buildInvitationEmail({ to, installUrl: EXTENSION_INSTALL_URL.value() });
    await deliverEmail({
      label: 'Correo de invitación',
      message,
      config: resendConfig(),
      isEmulator: isEmulator(),
      emailEnabled: EMAIL_ENABLED,
      send: sendEmail,
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

// Spec 2026-11-05-cumpleanos-aniversarios: Mondays 08:00, the week's birthdays
// and work anniversaries to the active admins.
export const weeklyCelebrationsDigest = onSchedule(
  {
    schedule: 'every monday 08:00',
    timeZone: DEFAULT_TIME_ZONE,
    region: SCHEDULER_REGION,
    secrets: EMAIL_SECRETS,
  },
  async () => {
    const result = await sendCelebrationsDigestCore({
      db: getFirestore(),
      monday: dateKey(Date.now(), DEFAULT_TIME_ZONE),
      portalUrl: process.env.PORTAL_URL?.trim() || null,
      config: resendConfig(),
      isEmulator: isEmulator(),
      emailEnabled: EMAIL_ENABLED,
      send: sendEmail,
      logger,
    });
    logger.info('Resumen semanal de cumpleaños terminado', result);
  },
);
