/**
 * Documents the portal writes, built exactly as `firestore.rules` accepts them.
 * Pure (the caller passes the admin uid and the clock) so they are unit tested.
 */
import {
  MAX_ALLOWED_DOMAINS,
  allowedDomainsOr,
  emailDomain,
  emailKey,
  formatDomains,
  isAllowedEmail,
  DEFAULT_ACTIVE_BREAK_TIMES,
  MAX_ACTIVE_BREAK_TIMES,
  isValidDomain,
  normalizeBreakTimes,
  normalizeDomain,
  normalizeDomainList,
  readActiveBreakSettings,
  readMoodPulseEnabled,
  readFeedbackEnabled,
  type ActiveBreakMode,
  type Invitation,
  type OrgConfig,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export interface OrgConfigForm {
  /** Allowed Workspace domains (normalized, in the order the admin added them). */
  allowedDomains: string[];
  screenshotsEnabled: boolean;
  blurScreenshots: boolean;
  /** Raw text of the input. */
  screenshotRetentionDays: string;
  pauseTimerAtLunch: boolean;
  /** Active breaks (spec 2026-10-21-pausa-activa). */
  activeBreaksEnabled: boolean;
  /** `interval`: after x min of continuous work; `daily`: x times a day (spec 2026-10-22); `times`: at fixed times (spec 2026-11-10). */
  activeBreakMode: ActiveBreakMode;
  activeBreakIntervalMinutes: number;
  activeBreaksPerDay: number;
  /** `times` mode: values of the time inputs ("HH:MM"; "" while empty). */
  activeBreakTimes: string[];
  activeBreakMinutes: number;
  /** Mood pulse when closing the work day (spec 2026-11-05-pulso-de-animo). */
  moodPulseEnabled: boolean;
  /** Anonymous comments from the popup (spec 2026-11-13-comentarios-anonimos). */
  feedbackEnabled: boolean;
}

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** Error for the domain list, or null when it is valid. `adminEmail`: its domain cannot be removed. */
export function validateDomainList(domains: readonly string[], adminEmail?: string | null): string | null {
  const list = normalizeDomainList(domains);
  if (list.length === 0) return 'Agrega al menos un dominio de Google Workspace (por ejemplo, empresa.cl).';
  if (list.length > MAX_ALLOWED_DOMAINS) return `Puedes tener como máximo ${MAX_ALLOWED_DOMAINS} dominios.`;
  const bad = list.find((d) => !isValidDomain(d));
  if (bad) return `El dominio “${bad}” no es válido (por ejemplo, empresa.cl).`;
  const own = adminEmail ? emailDomain(adminEmail) : null;
  if (own && !list.includes(own)) {
    return `No puedes quitar @${own}: es el dominio de tu propia cuenta.`;
  }
  return null;
}

export type AddDomainResult = { ok: true; domains: string[]; domain: string } | { ok: false; error: string };

/** Adds the typed domain to the list (normalized), rejecting invalid, repeated or too many. */
export function addDomain(domains: readonly string[], raw: string): AddDomainResult {
  const domain = normalizeDomain(raw);
  if (!domain) return { ok: false, error: 'Escribe el dominio que quieres agregar (por ejemplo, empresa.cl).' };
  if (!isValidDomain(domain)) return { ok: false, error: `El dominio “${domain}” no es válido (por ejemplo, empresa.cl).` };
  const list = normalizeDomainList(domains);
  if (list.includes(domain)) return { ok: false, error: `@${domain} ya está en la lista.` };
  if (list.length >= MAX_ALLOWED_DOMAINS) return { ok: false, error: `Puedes tener como máximo ${MAX_ALLOWED_DOMAINS} dominios.` };
  return { ok: true, domains: [...list, domain], domain };
}

/** True when `domain` can be removed: never the last one nor the admin's own domain. */
export function canRemoveDomain(domains: readonly string[], domain: string, adminEmail?: string | null): boolean {
  const list = normalizeDomainList(domains);
  if (list.length <= 1) return false;
  return !adminEmail || emailDomain(adminEmail) !== normalizeDomain(domain);
}

export function validateOrgConfig(form: OrgConfigForm, adminEmail?: string | null): FieldErrors<keyof OrgConfigForm> {
  const errors: FieldErrors<keyof OrgConfigForm> = {};
  const domainError = validateDomainList(form.allowedDomains, adminEmail);
  if (domainError) errors.allowedDomains = domainError;
  const raw = form.screenshotRetentionDays.trim();
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    errors.screenshotRetentionDays = `Escribe un número entero de días entre ${MIN_RETENTION_DAYS} y ${MAX_RETENTION_DAYS}.`;
  }
  const breakTimesError = validateBreakTimes(form);
  if (breakTimesError) errors.activeBreakTimes = breakTimesError;
  return errors;
}

/** Error of the fixed times (only with the reminders on in `times` mode), or null. */
export function validateBreakTimes(form: Pick<OrgConfigForm, 'activeBreaksEnabled' | 'activeBreakMode' | 'activeBreakTimes'>): string | null {
  if (!form.activeBreaksEnabled || form.activeBreakMode !== 'times') return null;
  const filled = form.activeBreakTimes.filter((t) => t !== '');
  if (filled.length === 0) return 'Agrega al menos una hora para la pausa activa.';
  if (new Set(filled).size !== filled.length) return 'Hay horas repetidas en la pausa activa.';
  if (!normalizeBreakTimes(filled)) return `Elige hasta ${MAX_ACTIVE_BREAK_TIMES} horas válidas para la pausa activa.`;
  return null;
}

/**
 * `config/org` with the 6 fields the rules require (`updatedBy` = caller), plus
 * `pauseTimerAtLunch` only when on: a full `setDoc` without it means off, and
 * saving with it off still works with the rules before 0.2.4. The same for
 * the active breaks: their fields only when on (rules before 0.2.7), and the
 * mode with the times a day only in `daily` mode (rules before 0.2.8), and
 * the fixed times only in `times` mode (rules before 0.2.22).
 */
export function buildOrgConfig(form: OrgConfigForm, uid: string, now: number, adminEmail?: string | null): OrgConfig {
  const errors = validateOrgConfig(form, adminEmail);
  if (Object.keys(errors).length > 0) throw new Error(Object.values(errors).join(' '));
  return {
    allowedDomains: normalizeDomainList(form.allowedDomains),
    screenshotsEnabled: form.screenshotsEnabled,
    blurScreenshots: form.blurScreenshots,
    screenshotRetentionDays: Number(form.screenshotRetentionDays.trim()),
    ...(form.pauseTimerAtLunch ? { pauseTimerAtLunch: true } : {}),
    ...(form.activeBreaksEnabled
      ? {
          activeBreaksEnabled: true,
          activeBreakIntervalMinutes: form.activeBreakIntervalMinutes,
          ...(form.activeBreakMode === 'daily'
            ? { activeBreakMode: 'daily' as const, activeBreaksPerDay: form.activeBreaksPerDay }
            : form.activeBreakMode === 'times'
              ? { activeBreakMode: 'times' as const, activeBreakTimes: normalizeBreakTimes(form.activeBreakTimes.filter((t) => t !== '')) ?? [] }
              : {}),
          activeBreakMinutes: form.activeBreakMinutes,
        }
      : {}),
    // Only when on (rules before the mood pulse do not know the field).
    ...(form.moodPulseEnabled ? { moodPulseEnabled: true } : {}),
    // Same for the anonymous comments.
    ...(form.feedbackEnabled ? { feedbackEnabled: true } : {}),
    updatedAt: Math.floor(now),
    updatedBy: uid,
  };
}

/** Form values; tolerates old docs with a single `allowedDomain`. */
export function orgConfigToForm(config: OrgConfig | null, fallbackDomains: readonly string[]): OrgConfigForm {
  return {
    allowedDomains: allowedDomainsOr(config, fallbackDomains),
    screenshotsEnabled: config?.screenshotsEnabled ?? false,
    blurScreenshots: config?.blurScreenshots ?? true,
    screenshotRetentionDays: String(config?.screenshotRetentionDays ?? 90),
    pauseTimerAtLunch: config?.pauseTimerAtLunch === true,
    ...activeBreaksForm(config),
    moodPulseEnabled: readMoodPulseEnabled(config),
    feedbackEnabled: readFeedbackEnabled(config),
  };
}

/** The active break fields of the form (page Pausa activa). */
export type ActiveBreaksForm = Pick<
  OrgConfigForm,
  'activeBreaksEnabled' | 'activeBreakMode' | 'activeBreakIntervalMinutes' | 'activeBreaksPerDay' | 'activeBreakTimes' | 'activeBreakMinutes'
>;

export function activeBreaksForm(config: OrgConfig | null): ActiveBreaksForm {
  const b = readActiveBreakSettings(config);
  return {
    activeBreaksEnabled: b.enabled,
    activeBreakMode: b.mode,
    activeBreakIntervalMinutes: b.intervalMinutes,
    activeBreaksPerDay: b.perDay,
    activeBreakTimes: b.times.length > 0 ? b.times : [...DEFAULT_ACTIVE_BREAK_TIMES],
    activeBreakMinutes: b.durationMinutes,
  };
}

// ---------- invitations ----------

export type InviteCheck =
  | { ok: true; id: string; email: string; mode: 'create' | 'reinvite' }
  | { ok: false; error: string };

/**
 * Validates the email typed in the invitation form against the allowed
 * domains (any of them), the existing invitations and the registered users.
 */
export function checkInvite(
  rawEmail: string,
  allowedDomains: readonly string[],
  invitations: readonly WithId<Invitation>[],
  users: readonly WithId<UserProfile>[],
): InviteCheck {
  const email = emailKey(rawEmail);
  if (!email) return { ok: false, error: 'Escribe el correo de la persona que quieres invitar.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'El correo no es válido.' };
  if (!isAllowedEmail(email, allowedDomains)) {
    return { ok: false, error: `Solo puedes invitar correos ${formatDomains(allowedDomains)}.` };
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
