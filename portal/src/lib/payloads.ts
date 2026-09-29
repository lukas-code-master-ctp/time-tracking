/**
 * Documents the portal writes, built exactly as `firestore.rules` accepts them.
 * Pure (the caller passes the admin uid and the clock) so they are unit tested.
 */
import {
  emailKey,
  isAllowedEmail,
  normalizeDomain,
  type Invitation,
  type OrgConfig,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export interface OrgConfigForm {
  allowedDomain: string;
  screenshotsEnabled: boolean;
  blurScreenshots: boolean;
  /** Raw text of the input. */
  screenshotRetentionDays: string;
}

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function validateOrgConfig(form: OrgConfigForm): FieldErrors<keyof OrgConfigForm> {
  const errors: FieldErrors<keyof OrgConfigForm> = {};
  const domain = normalizeDomain(form.allowedDomain);
  if (!domain) errors.allowedDomain = 'Escribe el dominio de Google Workspace (por ejemplo, empresa.cl).';
  else if (!DOMAIN_RE.test(domain)) errors.allowedDomain = 'El dominio no es válido (por ejemplo, empresa.cl).';
  const raw = form.screenshotRetentionDays.trim();
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    errors.screenshotRetentionDays = `Escribe un número entero de días entre ${MIN_RETENTION_DAYS} y ${MAX_RETENTION_DAYS}.`;
  }
  return errors;
}

/** `config/org` with the 6 fields the rules require (`updatedBy` = caller). */
export function buildOrgConfig(form: OrgConfigForm, uid: string, now: number): OrgConfig {
  const errors = validateOrgConfig(form);
  if (Object.keys(errors).length > 0) throw new Error(Object.values(errors).join(' '));
  return {
    allowedDomain: normalizeDomain(form.allowedDomain),
    screenshotsEnabled: form.screenshotsEnabled,
    blurScreenshots: form.blurScreenshots,
    screenshotRetentionDays: Number(form.screenshotRetentionDays.trim()),
    updatedAt: Math.floor(now),
    updatedBy: uid,
  };
}

export function orgConfigToForm(config: OrgConfig | null, fallbackDomain: string): OrgConfigForm {
  return {
    allowedDomain: config?.allowedDomain ?? fallbackDomain,
    screenshotsEnabled: config?.screenshotsEnabled ?? false,
    blurScreenshots: config?.blurScreenshots ?? true,
    screenshotRetentionDays: String(config?.screenshotRetentionDays ?? 90),
  };
}

// ---------- invitations ----------

export type InviteCheck =
  | { ok: true; id: string; email: string; mode: 'create' | 'reinvite' }
  | { ok: false; error: string };

/**
 * Validates the email typed in the invitation form against the allowed
 * domain, the existing invitations and the registered users.
 */
export function checkInvite(
  rawEmail: string,
  allowedDomain: string,
  invitations: readonly WithId<Invitation>[],
  users: readonly WithId<UserProfile>[],
): InviteCheck {
  const email = emailKey(rawEmail);
  if (!email) return { ok: false, error: 'Escribe el correo de la persona que quieres invitar.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'El correo no es válido.' };
  if (!isAllowedEmail(email, allowedDomain)) {
    return { ok: false, error: `Solo puedes invitar correos @${normalizeDomain(allowedDomain)}.` };
  }
  if (users.some((u) => emailKey(u.email) === email)) {
    return { ok: false, error: 'Esta persona ya es colaboradora. Gestiona su acceso en Colaboradores.' };
  }
  const existing = invitations.find((i) => i.id === email);
  if (existing?.status === 'pending') {
    return { ok: false, error: 'Ya tiene una invitación pendiente. Usa “Reenviar” en la lista.' };
  }
  if (existing?.status === 'accepted') {
    return { ok: false, error: 'Esta invitación ya fue aceptada.' };
  }
  return { ok: true, id: email, email, mode: existing ? 'reinvite' : 'create' };
}

/** New (or re-sent) pending invitation. Written with a full `set`. */
export function buildInvitation(email: string, uid: string, now: number): Invitation {
  return { email: emailKey(email), invitedBy: uid, invitedAt: Math.floor(now), status: 'pending' };
}

/**
 * Re-send: status back to pending with a new `invitedAt` (this triggers the
 * email in `onInvitationWritten`). The caller becomes `invitedBy`, as the
 * rules require. `acceptedAt` is dropped.
 */
export function buildResend(existing: Invitation, uid: string, now: number): Invitation {
  const invitedAt = Math.max(Math.floor(now), existing.invitedAt + 1);
  return { email: existing.email, invitedBy: uid, invitedAt, status: 'pending' };
}

export function buildRevoke(existing: Invitation): Invitation {
  const out: Invitation = {
    email: existing.email,
    invitedBy: existing.invitedBy,
    invitedAt: existing.invitedAt,
    status: 'revoked',
  };
  if (existing.acceptedAt !== undefined) out.acceptedAt = existing.acceptedAt;
  return out;
}

export const INVITATION_STATUS_LABEL: Record<Invitation['status'], string> = {
  pending: 'Pendiente',
  accepted: 'Aceptada',
  revoked: 'Revocada',
};

/** Pending first, then by most recent. */
export function sortInvitations<T extends Invitation>(list: readonly T[]): T[] {
  const rank = { pending: 0, accepted: 1, revoked: 2 } as const;
  return [...list].sort((a, b) => rank[a.status] - rank[b.status] || b.invitedAt - a.invitedAt);
}
