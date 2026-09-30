/** Pure reporting helpers used by the admin portal (and the popup). */

import { DEFAULT_TIME_ZONE } from './collections.js';
import { STALE_SESSION_MS } from './config.js';
import type { ActivitySlot, Role, Session, UrlTime, UserProfile, UserStatus } from './types.js';

export interface DomainTime {
  domain: string;
  seconds: number;
}

export interface SummaryOptions {
  /** Inclusive lower bound (ms). Slots are filtered by `slotStart`. */
  from?: number;
  /** Exclusive upper bound (ms). */
  to?: number;
  /** Current time; used to decide whether an open session is still alive. */
  now?: number;
  /** Size of top domain / URL lists (default 10). */
  topN?: number;
}

export interface MemberSummary {
  /** Measured seconds (sum of `trackedSeconds`). */
  trackedSeconds: number;
  activeSeconds: number;
  /** Seconds in a web meeting without keyboard/mouse (sum of `meetingSeconds`). */
  meetingSeconds: number;
  /**
   * activeSeconds / (trackedSeconds - meetingSeconds), 0..100 rounded, or
   * null when nothing outside meetings was measured.
   */
  activityPercent: number | null;
  outsideChromeSeconds: number;
  /**
   * Wall-clock duration of the sessions clipped to [from, to). Open sessions
   * count until their last heartbeat (last instant known to be alive).
   */
  sessionSeconds: number;
  sessionCount: number;
  /**
   * An open session with a recent heartbeat (<= 30 min before `now`). It
   * reflects the current state and ignores `from`/`to`.
   */
  inSession: boolean;
  lastActivityAt: number | null;
  slotCount: number;
  topDomains: DomainTime[];
  topUrls: UrlTime[];
}

export interface TeamMember extends UserProfile {
  uid: string;
}

export interface TeamRow extends MemberSummary {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
}

export interface TeamSummary {
  rows: TeamRow[];
  totals: {
    members: number;
    membersInSession: number;
    trackedSeconds: number;
    activeSeconds: number;
    meetingSeconds: number;
    activityPercent: number | null;
    outsideChromeSeconds: number;
    sessionSeconds: number;
  };
}

/**
 * activeSeconds / (trackedSeconds - meetingSeconds) as a rounded percentage
 * (0..100). Meeting time neither raises nor lowers the percentage. Returns
 * null when the denominator is 0: nothing measured, or everything measured
 * was a meeting (shown as "—" and left out of averages).
 */
export function activityPercent(activeSeconds: number, trackedSeconds: number, meetingSeconds = 0): number | null {
  const base = trackedSeconds - Math.max(0, Number.isFinite(meetingSeconds) ? meetingSeconds : 0);
  if (!(base > 0)) return null;
  const pct = Math.round((Math.max(0, activeSeconds) / base) * 100);
  return Math.min(100, Math.max(0, pct));
}

/**
 * `meetingSeconds` of a block, normalized: 0 when missing (documents written
 * by extension 0.1.1 or older) or invalid, integer, and clamped so that
 * active + meeting never exceeds tracked.
 */
export function meetingSecondsOf(slot: Pick<ActivitySlot, 'trackedSeconds' | 'activeSeconds' | 'meetingSeconds'>): number {
  const tracked = Math.max(0, Number.isFinite(slot.trackedSeconds) ? slot.trackedSeconds : 0);
  const active = Math.min(Math.max(0, Number.isFinite(slot.activeSeconds) ? slot.activeSeconds : 0), tracked);
  const raw = slot.meetingSeconds;
  const meeting = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  return Math.min(meeting, Math.max(0, tracked - active));
}

function inRange(ms: number, from: number | undefined, to: number | undefined): boolean {
  return (from === undefined || ms >= from) && (to === undefined || ms < to);
}

function byCountDesc<T extends { seconds: number }>(key: (x: T) => string) {
  return (a: T, b: T): number => {
    if (b.seconds !== a.seconds) return b.seconds - a.seconds;
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

/** Duration of a session clipped to [from, to), in whole seconds. */
export function sessionDurationSeconds(session: Session, from?: number, to?: number): number {
  const end = session.endedAt ?? session.lastHeartbeatAt;
  const start = Math.max(session.startedAt, from ?? -Infinity);
  const stop = Math.min(Math.max(end, session.startedAt), to ?? Infinity);
  return stop > start ? Math.floor((stop - start) / 1000) : 0;
}

/** True when the session is open and its heartbeat is recent enough. */
export function isSessionLive(session: Session, now?: number): boolean {
  if (session.endedAt !== null) return false;
  return now === undefined || now - session.lastHeartbeatAt <= STALE_SESSION_MS;
}

/** Summary of one collaborator. `slots`/`sessions` must belong to that person. */
export function summarizeMember(
  slots: readonly ActivitySlot[],
  sessions: readonly Session[],
  options: SummaryOptions = {},
): MemberSummary {
  const { from, to, now } = options;
  const topN = options.topN ?? 10;
  let trackedSeconds = 0;
  let activeSeconds = 0;
  let meetingSeconds = 0;
  let outsideChromeSeconds = 0;
  let slotCount = 0;
  let lastActivityAt: number | null = null;
  const domains = new Map<string, number>();
  const urls = new Map<string, number>();

  for (const slot of slots) {
    if (!inRange(slot.slotStart, from, to)) continue;
    slotCount++;
    const tracked = Math.max(0, slot.trackedSeconds);
    trackedSeconds += tracked;
    activeSeconds += Math.min(Math.max(0, slot.activeSeconds), tracked);
    meetingSeconds += meetingSecondsOf(slot);
    outsideChromeSeconds += Math.min(Math.max(0, slot.outsideChromeSeconds), tracked);
    for (const [d, s] of Object.entries(slot.domains ?? {})) domains.set(d, (domains.get(d) ?? 0) + s);
    for (const u of slot.urls ?? []) urls.set(u.url, (urls.get(u.url) ?? 0) + u.seconds);
    if (tracked > 0) {
      // Approximate end of measured time inside the block.
      const end = slot.slotStart + tracked * 1000;
      if (lastActivityAt === null || end > lastActivityAt) lastActivityAt = end;
    }
  }

  let sessionSeconds = 0;
  let sessionCount = 0;
  let inSession = false;
  for (const session of sessions) {
    // "In session" describes the present, not the selected range: a live
    // session counts even when the range is in the past.
    if (isSessionLive(session, now)) inSession = true;
    const end = session.endedAt ?? session.lastHeartbeatAt;
    const overlaps = (to === undefined || session.startedAt < to) && (from === undefined || end >= from);
    if (!overlaps) continue;
    sessionCount++;
    sessionSeconds += sessionDurationSeconds(session, from, to);
    const alive = Math.max(session.lastHeartbeatAt, session.endedAt ?? 0);
    if (lastActivityAt === null || alive > lastActivityAt) lastActivityAt = alive;
  }

  return {
    trackedSeconds,
    activeSeconds,
    meetingSeconds,
    activityPercent: activityPercent(activeSeconds, trackedSeconds, meetingSeconds),
    outsideChromeSeconds,
    sessionSeconds,
    sessionCount,
    inSession,
    lastActivityAt,
    slotCount,
    topDomains: [...domains.entries()]
      .map(([domain, seconds]) => ({ domain, seconds }))
      .sort(byCountDesc<DomainTime>((x) => x.domain))
      .slice(0, topN),
    topUrls: [...urls.entries()]
      .map(([url, seconds]) => ({ url, seconds }))
      .sort(byCountDesc<UrlTime>((x) => x.url))
      .slice(0, topN),
  };
}

/** Team table: one row per member (sorted by name), plus totals. */
export function summarizeTeam(
  members: readonly TeamMember[],
  slots: readonly ActivitySlot[],
  sessions: readonly (Session & { id?: string })[],
  options: SummaryOptions = {},
): TeamSummary {
  const slotsByUid = new Map<string, ActivitySlot[]>();
  for (const s of slots) {
    const list = slotsByUid.get(s.uid);
    if (list) list.push(s);
    else slotsByUid.set(s.uid, [s]);
  }
  const sessionsByUid = new Map<string, Session[]>();
  for (const s of sessions) {
    const list = sessionsByUid.get(s.uid);
    if (list) list.push(s);
    else sessionsByUid.set(s.uid, [s]);
  }

  const rows: TeamRow[] = members.map((m) => ({
    uid: m.uid,
    email: m.email,
    displayName: m.displayName || m.email,
    role: m.role,
    status: m.status,
    ...summarizeMember(slotsByUid.get(m.uid) ?? [], sessionsByUid.get(m.uid) ?? [], options),
  }));
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName, 'es') || a.email.localeCompare(b.email));

  const sum = (f: (r: TeamRow) => number): number => rows.reduce((acc, r) => acc + f(r), 0);
  const trackedSeconds = sum((r) => r.trackedSeconds);
  const activeSeconds = sum((r) => r.activeSeconds);
  const meetingSeconds = sum((r) => r.meetingSeconds);
  return {
    rows,
    totals: {
      members: rows.length,
      membersInSession: rows.filter((r) => r.inSession).length,
      trackedSeconds,
      activeSeconds,
      meetingSeconds,
      activityPercent: activityPercent(activeSeconds, trackedSeconds, meetingSeconds),
      outsideChromeSeconds: sum((r) => r.outsideChromeSeconds),
      sessionSeconds: sum((r) => r.sessionSeconds),
    },
  };
}

// --- Formatting -------------------------------------------------------------

/** Human duration in Spanish: "0 min", "45 min", "3 h 05 min". */
export function formatDuration(seconds: number): string {
  const totalMin = Math.floor(Math.max(0, seconds) / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/** Seconds to decimal hours with 2 decimals (for CSV / spreadsheets). */
export function secondsToHours(seconds: number): number {
  return Math.round((Math.max(0, seconds) / 3600) * 100) / 100;
}

/** `YYYY-MM-DD HH:mm` in the given time zone. */
export function formatDateTime(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// --- CSV --------------------------------------------------------------------

export type CsvCell = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvCell>;

export interface CsvColumn {
  key: string;
  header: string;
}

export interface CsvOptions {
  /** Field separator (default ","). Use ";" for Excel in Spanish locales. */
  separator?: string;
  /** Prepend a UTF-8 BOM so Excel detects the encoding (default false). */
  bom?: boolean;
  /**
   * Decimal mark for numbers (default "."). Excel in Spanish locales (Chile)
   * expects ";" as separator and "," as decimal mark; otherwise "1.5" is read
   * as text or as a date.
   */
  decimalSeparator?: '.' | ',';
}

/**
 * Escapes one CSV field (RFC 4180): fields containing the separator, quotes
 * or line breaks are quoted and quotes are doubled. Text starting with
 * `= + - @` (or tab / CR) is prefixed with `'` to prevent formula injection
 * in spreadsheets. Numbers are written as-is (negative numbers stay numeric).
 */
export function escapeCsvField(value: CsvCell, separator = ',', decimalSeparator: '.' | ',' = '.'): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const num = decimalSeparator === ',' ? String(value).replace('.', ',') : String(value);
    return num.includes(separator) ? `"${num}"` : num;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (text.includes(separator) || /["\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Serializes rows to CSV with CRLF line endings. Columns default to the union
 * of row keys in first-seen order, using the key as header.
 */
export function toCsv(rows: readonly CsvRow[], columns?: readonly CsvColumn[], options: CsvOptions = {}): string {
  const separator = options.separator ?? ',';
  const decimal = options.decimalSeparator ?? '.';
  let cols: readonly CsvColumn[];
  if (columns) {
    cols = columns;
  } else {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
    }
    cols = keys.map((key) => ({ key, header: key }));
  }
  const lines = [cols.map((c) => escapeCsvField(c.header, separator)).join(separator)];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCsvField(row[c.key], separator, decimal)).join(separator));
  }
  return (options.bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

/** Extra columns appended to {@link teamSummaryToCsv} (e.g. the portal's schedule compliance). */
export interface TeamCsvExtra {
  columns: readonly CsvColumn[];
  /** Values of the extra columns for one row (keys = `columns[].key`). */
  values(row: TeamRow): CsvRow;
}

/** Team summary CSV with Spanish headers (user-visible export). */
export function teamSummaryToCsv(
  team: TeamSummary,
  options: CsvOptions & { timeZone?: string; extra?: TeamCsvExtra } = {},
): string {
  const columns: CsvColumn[] = [
    { key: 'displayName', header: 'Nombre' },
    { key: 'email', header: 'Correo' },
    { key: 'state', header: 'Estado' },
    { key: 'sessionHours', header: 'Horas en jornada' },
    { key: 'trackedHours', header: 'Horas medidas' },
    { key: 'activityPercent', header: 'Actividad (%)' },
    { key: 'meetingHours', header: 'Horas en reunión' },
    { key: 'outsideChromeHours', header: 'Horas fuera de Chrome' },
    { key: 'sessionCount', header: 'Jornadas' },
    { key: 'topDomain', header: 'Dominio principal' },
    { key: 'lastActivity', header: 'Última actividad' },
  ];
  const rows: CsvRow[] = team.rows.map((r) => ({
    displayName: r.displayName,
    email: r.email,
    state: r.status === 'disabled' ? 'Desactivado' : r.inSession ? 'En jornada' : 'Fuera de jornada',
    sessionHours: secondsToHours(r.sessionSeconds),
    trackedHours: secondsToHours(r.trackedSeconds),
    // null (no data, or only meetings) → empty cell.
    activityPercent: r.activityPercent,
    meetingHours: secondsToHours(r.meetingSeconds),
    outsideChromeHours: secondsToHours(r.outsideChromeSeconds),
    sessionCount: r.sessionCount,
    topDomain: r.topDomains[0]?.domain ?? '',
    lastActivity: r.lastActivityAt === null ? '' : formatDateTime(r.lastActivityAt, options.timeZone),
    // Extra values never overwrite the base columns.
    ...Object.fromEntries(Object.entries(options.extra?.values(r) ?? {}).filter(([k]) => !columns.some((c) => c.key === k))),
  }));
  const extra = (options.extra?.columns ?? []).filter((c) => !columns.some((b) => b.key === c.key));
  return toCsv(rows, [...columns, ...extra], options);
}
