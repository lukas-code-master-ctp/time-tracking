/**
 * Helpers of the Comunicados page (spec 2026-11-13-grupos-y-comunicados-agendados):
 * the `datetime-local` value of a scheduled send, who an announcement goes
 * to, and keeping scheduled announcements in step with their groups.
 */
import {
  ANNOUNCEMENT_EVERYONE,
  MAX_ANNOUNCEMENT_AUDIENCE,
  announcementAudience,
  isForEveryone,
  isScheduled,
  membersOf,
  type Announcement,
  type PersonGroup,
  type WithId,
} from '@timetracking/shared';
import type { DataSource } from '../data/types';
import { addDays, isValidDate, startOfDay, zonedDate, zonedParts } from './dates';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * `YYYY-MM-DDTHH:mm` of an instant in the organization's zone (value of
 * `<input type="datetime-local">`). The portal shows every time in that zone,
 * so the input does too, whatever the computer's zone.
 */
export function toLocalInput(ms: number): string {
  const p = zonedParts(ms);
  return `${p.date}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Instant of a `datetime-local` value in the organization's zone, NaN when empty or invalid. */
export function fromLocalInput(value: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m || !isValidDate(m[1]!)) return Number.NaN;
  const date = m[1]!;
  const wanted = Number(m[2]) * 60 + Number(m[3]);
  if (wanted >= 24 * 60) return Number.NaN;
  // Minutes from the start of the day; corrected once if a DST change falls in between.
  let t = startOfDay(date) + wanted * 60_000;
  const p = zonedParts(t);
  const got = (p.date === date ? 0 : p.date > date ? 24 * 60 : -24 * 60) + p.hour * 60 + p.minute;
  t += (wanted - got) * 60_000;
  return t;
}

/** Suggested time when the admin switches to "Programar": tomorrow at 9:00 (organization's zone). */
export function defaultScheduleTime(now: number): number {
  return fromLocalInput(`${addDays(zonedDate(now), 1)}T09:00`);
}

/** "Todo el equipo", or the names of its groups ("Terreno, Ventas"; a deleted group is "Grupo eliminado"). */
export function audienceLabel(a: Pick<Announcement, 'audience' | 'groupIds'>, groups: readonly WithId<PersonGroup>[]): string {
  if (isForEveryone(a)) return 'Todo el equipo';
  const names = (a.groupIds ?? []).map((id) => groups.find((g) => g.id === id)?.name ?? 'Grupo eliminado');
  return names.length === 0 ? 'Algunas personas' : names.join(', ');
}

/** Of `people`, the ones the announcement goes to. */
export function recipientsOf<P extends { id: string }>(a: Pick<Announcement, 'audience'>, people: readonly P[]): P[] {
  if (isForEveryone(a)) return [...people];
  const audience = new Set(announcementAudience(a));
  return people.filter((p) => audience.has(p.id));
}

/** `audience` for the chosen groups (null = everyone). */
export function audienceFor(groupIds: readonly string[] | null, groups: readonly WithId<PersonGroup>[]): string[] {
  return groupIds === null ? [ANNOUNCEMENT_EVERYONE] : membersOf(groups, groupIds);
}

/**
 * After a group is saved: the scheduled announcements (not sent yet) sent to
 * it copy its members again, so the change reaches them. Sent ones keep the
 * people they went to.
 */
export async function syncScheduledAnnouncements(data: DataSource, groupId: string, group: PersonGroup): Promise<void> {
  const now = Date.now();
  const [announcements, stored] = await Promise.all([data.listAnnouncements(), data.listGroups()]);
  const groups = [...stored.filter((g) => g.id !== groupId), { ...group, id: groupId }];
  for (const a of announcements) {
    if (a.archivedAt !== null || !isScheduled(a, now) || isForEveryone(a) || !(a.groupIds ?? []).includes(groupId)) continue;
    const audience = membersOf(groups, a.groupIds ?? []);
    if (audience.length === 0 || audience.length > MAX_ANNOUNCEMENT_AUDIENCE) continue;
    const same = audience.length === (a.audience ?? []).length && audience.every((u) => a.audience!.includes(u));
    if (!same) await data.updateAnnouncement(a.id, { audience });
  }
}

/** Announcements from before 0.2.29 get `publishAt`, `audience` and `groupIds` (everyone, sent when created). */
export async function upgradeLegacyAnnouncements(data: DataSource, list: WithId<Announcement>[]): Promise<WithId<Announcement>[]> {
  return Promise.all(
    list.map(async (a) => {
      if (a.audience !== undefined) return a;
      const patch = { publishAt: a.createdAt, audience: [ANNOUNCEMENT_EVERYONE], groupIds: [] as string[] };
      try {
        await data.updateAnnouncement(a.id, patch);
      } catch (err) {
        console.warn('[timetracking] no se pudo actualizar un comunicado antiguo', err);
        return a;
      }
      return { ...a, ...patch };
    }),
  );
}
