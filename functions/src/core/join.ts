/**
 * Business logic of the `joinOrg` callable (spec section 6).
 *
 * Kept free of the Functions runtime: it receives the Firestore instance, the
 * clock and the config, so tests run it directly against the emulator.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  COLLECTIONS,
  ORG_CONFIG_DOC_ID,
  defaultOrgConfig,
  allowedDomainsOr,
  emailKey,
  formatDomains,
  isAllowedEmail,
  type Invitation,
  type OrgConfig,
  type Role,
  type UserProfile,
} from '@timetracking/shared';

/** Identity of the caller, taken from the verified ID token. */
export interface JoinCaller {
  uid: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  displayName?: string | undefined;
  photoURL?: string | undefined;
}

export interface JoinDeps {
  db: Firestore;
  now: number;
  /** Used when `config/org` does not exist yet (or has no domains). */
  fallbackAllowedDomains: readonly string[];
  /** Lowercase emails that become admin without invitation. */
  bootstrapAdmins: readonly string[];
}

/**
 * Machine-readable reason in `HttpsError.details.reason`, so clients can show
 * the right screen without parsing the message.
 */
export type JoinRejection =
  | 'unauthenticated'
  | 'no-email'
  | 'email-not-verified'
  | 'domain-not-allowed'
  | 'no-invitation'
  | 'invitation-revoked'
  | 'user-disabled';

export interface JoinResult {
  profile: UserProfile;
  /** True when this call created `users/{uid}`. */
  created: boolean;
}

function reject(
  code: 'unauthenticated' | 'permission-denied',
  reason: JoinRejection,
  message: string,
): never {
  throw new HttpsError(code, message, { reason });
}

function displayNameOf(caller: JoinCaller, email: string): string {
  const name = caller.displayName?.trim();
  if (name) return name;
  return email.slice(0, email.indexOf('@'));
}

export async function joinOrgCore(deps: JoinDeps, caller: JoinCaller | null): Promise<JoinResult> {
  if (!caller?.uid) {
    reject('unauthenticated', 'unauthenticated', 'Debes iniciar sesión para unirte.');
  }
  const email = caller.email ? emailKey(caller.email) : '';
  if (!email) {
    reject('permission-denied', 'no-email', 'Tu cuenta no tiene un correo asociado.');
  }
  if (caller.emailVerified !== true) {
    reject(
      'permission-denied',
      'email-not-verified',
      'Tu correo no está verificado. Inicia sesión con tu cuenta Google de la empresa.',
    );
  }

  const { db, now } = deps;
  const configRef = db.collection(COLLECTIONS.config).doc(ORG_CONFIG_DOC_ID);
  const userRef = db.collection(COLLECTIONS.users).doc(caller.uid);
  const invitationRef = db.collection(COLLECTIONS.invitations).doc(email);
  const isBootstrap = deps.bootstrapAdmins.map(emailKey).includes(email);

  return db.runTransaction(async (tx) => {
    // All reads first (Firestore transactions require it).
    const [configSnap, userSnap, invitationSnap] = await Promise.all([
      tx.get(configRef),
      tx.get(userRef),
      tx.get(invitationRef),
    ]);

    // Tolerates old documents with a single `allowedDomain` (read as a list).
    const config = configSnap.exists ? (configSnap.data() as Partial<OrgConfig>) : undefined;
    const allowedDomains = allowedDomainsOr(config, deps.fallbackAllowedDomains);

    if (!isAllowedEmail(email, allowedDomains)) {
      reject(
        'permission-denied',
        'domain-not-allowed',
        `Usa tu cuenta de la empresa (${formatDomains(allowedDomains)}).`,
      );
    }

    const invitation = invitationSnap.exists ? (invitationSnap.data() as Invitation) : undefined;

    // Already registered: the users doc is the authority (role and status are
    // managed by admins from the portal). Idempotent.
    if (userSnap.exists) {
      const profile = userSnap.data() as UserProfile;
      if (profile.status !== 'active') {
        reject(
          'permission-denied',
          'user-disabled',
          'Tu cuenta está desactivada. Habla con tu administrador.',
        );
      }
      if (invitation?.status === 'pending') {
        tx.update(invitationRef, { status: 'accepted', acceptedAt: now });
      }
      return { profile, created: false };
    }

    let role: Role;
    if (isBootstrap) {
      role = 'admin';
    } else if (invitation?.status === 'pending' || invitation?.status === 'accepted') {
      role = 'member';
    } else if (invitation?.status === 'revoked') {
      reject(
        'permission-denied',
        'invitation-revoked',
        'Tu invitación fue revocada. Pide a tu administrador que te invite de nuevo.',
      );
    } else {
      reject(
        'permission-denied',
        'no-invitation',
        'No tienes una invitación. Pide a tu administrador que te invite.',
      );
    }

    const profile: UserProfile = {
      email,
      displayName: displayNameOf(caller, email),
      photoURL: caller.photoURL?.trim() ? caller.photoURL.trim() : null,
      role,
      status: 'active',
      createdAt: now,
    };
    tx.create(userRef, profile);

    if (invitation && invitation.status !== 'accepted') {
      tx.update(invitationRef, { status: 'accepted', acceptedAt: now });
    }
    if (role === 'admin' && !configSnap.exists) {
      tx.create(configRef, defaultOrgConfig(now, allowedDomains, 'system'));
    }
    return { profile, created: true };
  });
}
