/**
 * Groups of people (spec 2026-11-13-grupos-y-comunicados-agendados): an
 * admin names a group and picks its members in the portal. Pure helpers.
 */
import type { ScheduleIssue } from './schedule.js';
import type { PersonGroup, WithId } from './types.js';

/** Same limits as `firestore.rules`. */
export const MAX_GROUP_NAME = 60;
export const MAX_GROUP_MEMBERS = 500;

/** Problems of a group being edited ([] = valid). `others` = the other groups (unique names). Messages in Spanish. */
export function validateGroup(
  g: Pick<PersonGroup, 'name' | 'memberUids'>,
  others: readonly Pick<PersonGroup, 'name'>[] = [],
): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const name = typeof g.name === 'string' ? g.name.trim() : '';
  if (name === '') issues.push({ path: 'name', message: 'Ponle un nombre al grupo.' });
  else if (name.length > MAX_GROUP_NAME) issues.push({ path: 'name', message: `El nombre puede tener hasta ${MAX_GROUP_NAME} caracteres.` });
  else if (others.some((o) => o.name.trim().toLocaleLowerCase('es') === name.toLocaleLowerCase('es'))) {
    issues.push({ path: 'name', message: 'Ya hay un grupo con ese nombre.' });
  }
  if (!Array.isArray(g.memberUids) || g.memberUids.length === 0) issues.push({ path: 'memberUids', message: 'Elige al menos una persona.' });
  else if (g.memberUids.length > MAX_GROUP_MEMBERS) {
    issues.push({ path: 'memberUids', message: `Un grupo puede tener hasta ${MAX_GROUP_MEMBERS} personas.` });
  }
  return issues;
}

/** Valid group document read from Firestore, or null. */
export function readGroup(raw: unknown): PersonGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.name !== 'string' || !Array.isArray(d.memberUids) || !d.memberUids.every((u) => typeof u === 'string')) return null;
  if (typeof d.createdAt !== 'number' || typeof d.createdBy !== 'string') return null;
  if (typeof d.updatedAt !== 'number' || typeof d.updatedBy !== 'string') return null;
  return {
    name: d.name,
    memberUids: [...(d.memberUids as string[])],
    createdAt: d.createdAt,
    createdBy: d.createdBy,
    updatedAt: d.updatedAt,
    updatedBy: d.updatedBy,
  };
}

/** Groups `uid` belongs to. */
export function groupsOf<G extends Pick<PersonGroup, 'memberUids'>>(groups: readonly G[], uid: string): G[] {
  return groups.filter((g) => g.memberUids.includes(uid));
}

/** Members of the groups `groupIds` (union, without repeats, in order of appearance). Unknown ids are ignored. */
export function membersOf(groups: readonly WithId<Pick<PersonGroup, 'memberUids'>>[], groupIds: readonly string[]): string[] {
  const wanted = new Set(groupIds);
  const out = new Set<string>();
  for (const g of groups) if (wanted.has(g.id)) for (const uid of g.memberUids) out.add(uid);
  return [...out];
}

/** Groups by name (Spanish order). */
export function sortGroups<G extends Pick<PersonGroup, 'name'>>(groups: readonly G[]): G[] {
  return [...groups].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}
