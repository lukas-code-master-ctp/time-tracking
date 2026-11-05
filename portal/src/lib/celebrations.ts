/**
 * Birthdays and work anniversaries in the portal (spec
 * 2026-11-05-cumpleanos-aniversarios): form state of one person and the
 * document saved in `celebrations/{uid}`.
 */
import { validateCelebration, type Celebration, type UserProfile, type WithId } from '@timetracking/shared';

export interface CelebrationForm {
  /** '01'..'12' or '' (none). */
  birthMonth: string;
  /** '01'..'31' or '' (none). */
  birthDay: string;
  /** `YYYY-MM-DD` or '' (none). */
  hireDate: string;
  /** uid of the boss or '' (none). */
  managerUid: string;
}

export const EMPTY_CELEBRATION_FORM: CelebrationForm = { birthMonth: '', birthDay: '', hireDate: '', managerUid: '' };

export function celebrationToForm(c: Celebration | null | undefined): CelebrationForm {
  if (!c) return EMPTY_CELEBRATION_FORM;
  return {
    birthMonth: c.birthday ? c.birthday.slice(0, 2) : '',
    birthDay: c.birthday ? c.birthday.slice(3, 5) : '',
    hireDate: c.hireDate ?? '',
    managerUid: c.managerUid ?? '',
  };
}

/** Error message of the form (Spanish), or null when it can be saved. */
export function celebrationFormError(f: CelebrationForm, today: string): string | null {
  if ((f.birthMonth === '') !== (f.birthDay === '')) return 'Elige el día y el mes del cumpleaños.';
  const issues = validateCelebration(formFields(f), today);
  return issues[0]?.message ?? null;
}

function formFields(f: CelebrationForm): Pick<Celebration, 'birthday' | 'hireDate'> & { managerUid: string | null } {
  return {
    birthday: f.birthMonth && f.birthDay ? `${f.birthMonth}-${f.birthDay}` : null,
    hireDate: f.hireDate || null,
    managerUid: f.managerUid || null,
  };
}

/** The whole `celebrations/{uid}` document for `user`. */
export function buildCelebration(user: UserProfile, f: CelebrationForm, adminUid: string, now: number): Celebration {
  return {
    displayName: (user.displayName || user.email).slice(0, 200),
    ...formFields(f),
    active: user.status === 'active',
    updatedAt: now,
    updatedBy: adminUid,
  };
}

/** Same document with the status of the account (after activating or deactivating it). */
export function withStatus(c: WithId<Celebration>, user: UserProfile, adminUid: string, now: number): Celebration {
  const { id: _id, ...rest } = c;
  return { ...rest, displayName: (user.displayName || user.email).slice(0, 200), active: user.status === 'active', updatedAt: now, updatedBy: adminUid };
}

export function sameForm(a: CelebrationForm, b: CelebrationForm): boolean {
  return a.birthMonth === b.birthMonth && a.birthDay === b.birthDay && a.hireDate === b.hireDate && a.managerUid === b.managerUid;
}
