import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SLOT_MS,
  emailDomain,
  isAllowedEmail,
  isSessionLive,
  parseDomainList,
  parseEmailList,
  sanitizeUrl,
  slotStartOf,
  dateKey as dateKeyOf,
} from '@timetracking/shared';
import { mockScreenHtml } from '../lib/mockScreens';
import { LEGACY_DAYS, PENDING_INVITE, PEOPLE, SITES, atLocal, buildDataset, rng } from '../lib/seedData';
import { ADMIN_EMAIL, DOMAINS } from '../lib/emulators';
import { zonedParts } from '../../portal/src/lib/dates';

// Tuesday 2026-09-29 15:30 in Santiago.
const NOW = Date.UTC(2026, 8, 29, 18, 30);
const UIDS = { ana: 'u-ana', beto: 'u-beto', carla: 'u-carla' };

describe('seed people and domains', () => {
  const env = Object.fromEntries(
    readFileSync(new URL('../../functions/.env.demo-timetracking', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

  it('admin and domains match functions/.env.demo-timetracking', () => {
    expect(ADMIN_EMAIL).toBe('lukas@impulseai.cl');
    expect(parseEmailList(env.BOOTSTRAP_ADMINS)).toContain(ADMIN_EMAIL);
    expect(parseDomainList(env.ALLOWED_DOMAIN)).toEqual([...DOMAINS]);
  });

  it('collaborators and the pending invitation belong to the allowed domains, covering both', () => {
    const emails = [...PEOPLE.map((p) => p.email), PENDING_INVITE];
    for (const e of emails) expect(isAllowedEmail(e, DOMAINS), e).toBe(true);
    expect(new Set(PEOPLE.map((p) => emailDomain(p.email)))).toEqual(new Set(DOMAINS));
  });
});

describe('seed data', () => {
  const data = buildDataset(NOW, UIDS);

  it('is deterministic for the same instant', () => {
    expect(buildDataset(NOW, UIDS)).toEqual(data);
    const r1 = rng('x');
    const r2 = rng('x');
    expect([r1(), r1()]).toEqual([r2(), r2()]);
  });

  it('local times follow the Santiago clock (also on the DST day)', () => {
    expect(zonedParts(atLocal('2026-09-29', 9, 5))).toMatchObject({ date: '2026-09-29', hour: 9, minute: 5 });
    // 2026-09-06 starts at 01:00 (clock jumps at midnight).
    expect(zonedParts(atLocal('2026-09-06', 9, 0))).toMatchObject({ date: '2026-09-06', hour: 9, minute: 0 });
  });

  it('activity blocks respect the model invariants', () => {
    expect(data.activity.length).toBeGreaterThan(300);
    const ids = new Set<string>();
    for (const a of data.activity) {
      expect(a.slotStart % SLOT_MS).toBe(0);
      expect(a.slotStart).toBeLessThan(NOW);
      expect(a.trackedSeconds).toBeGreaterThan(0);
      expect(a.trackedSeconds).toBeLessThanOrEqual(600);
      expect(a.activeSeconds).toBeGreaterThanOrEqual(0);
      expect(a.activeSeconds).toBeLessThanOrEqual(a.trackedSeconds);
      expect(a.outsideChromeSeconds).toBeLessThanOrEqual(a.trackedSeconds);
      // Same constraints as firestore.rules: optional, integer >= 0, active + meeting <= tracked.
      if (a.meetingSeconds !== undefined) {
        expect(Number.isInteger(a.meetingSeconds)).toBe(true);
        expect(a.meetingSeconds).toBeGreaterThanOrEqual(0);
        expect(a.activeSeconds + a.meetingSeconds).toBeLessThanOrEqual(a.trackedSeconds);
      }
      const inDomains = Object.values(a.domains).reduce((s, v) => s + v, 0);
      expect(inDomains + a.outsideChromeSeconds).toBe(a.trackedSeconds);
      expect(a.urls.length).toBeLessThanOrEqual(20);
      for (const u of a.urls) expect(sanitizeUrl(u.url)).toBe(u.url);
      const id = `${a.uid}_${a.slotStart}`;
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });

  it('sessions: working hours, no overlaps, one open now', () => {
    const byUid = new Map<string, typeof data.sessions>();
    for (const s of data.sessions) byUid.set(s.data.uid, [...(byUid.get(s.data.uid) ?? []), s]);
    for (const list of byUid.values()) {
      const sorted = [...list].sort((a, b) => a.data.startedAt - b.data.startedAt);
      for (let i = 1; i < sorted.length; i++) {
        const prevEnd = sorted[i - 1]!.data.endedAt ?? sorted[i - 1]!.data.lastHeartbeatAt;
        // Never two sessions in the same 10-minute block.
        expect(slotStartOf(sorted[i]!.data.startedAt)).toBeGreaterThan(slotStartOf(prevEnd));
      }
    }
    const open = data.sessions.filter((s) => s.data.endedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.data.uid).toBe('u-ana');
    expect(isSessionLive(open[0]!.data, NOW)).toBe(true);
    expect(data.sessions.some((s) => s.data.endReason === 'auto')).toBe(true);
    for (const s of data.sessions.filter((x) => dateKeyOf(x.data.startedAt) < dateKeyOf(NOW))) {
      const h = zonedParts(s.data.startedAt).hour;
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThanOrEqual(14);
    }
    // No work on the weekend.
    expect(data.sessions.some((s) => ['2026-09-26', '2026-09-27'].includes(dateKeyOf(s.data.startedAt)))).toBe(false);
    // Every block belongs to a session of its person.
    const sessions = new Map(data.sessions.map((s) => [s.id, s.data]));
    for (const a of data.activity) expect(sessions.get(a.sessionId)?.uid).toBe(a.uid);
  });

  it('screenshots: a few, inside their session, one per block', () => {
    expect(data.shots.length).toBeGreaterThanOrEqual(6);
    expect(data.shots.length).toBeLessThanOrEqual(30);
    const sessions = new Map(data.sessions.map((s) => [s.id, s.data]));
    const ids = new Set(data.shots.map((s) => s.id));
    expect(ids.size).toBe(data.shots.length);
    for (const s of data.shots) {
      const session = sessions.get(s.sessionId)!;
      expect(s.takenAt).toBeGreaterThanOrEqual(session.startedAt);
      expect(s.takenAt).toBeLessThanOrEqual(session.endedAt ?? NOW);
      expect(s.id).toBe(`${s.uid}_${slotStartOf(s.takenAt)}`);
      expect(s.task).not.toBe('outside');
    }
  });

  it('meetings: 30-min dailies, a 1-hour meeting and old days without meetingSeconds (0.1.1)', () => {
    const today = dateKeyOf(NOW);
    const legacyUntil = dateKeyOf(NOW - LEGACY_DAYS * 86_400_000);
    const local = (a: { slotStart: number }) => zonedParts(a.slotStart);
    const mostlyMeeting = (a: { trackedSeconds: number; meetingSeconds?: number }) => (a.meetingSeconds ?? 0) >= a.trackedSeconds / 2;
    const topDomain = (a: { domains: Record<string, number> }) => Object.entries(a.domains).sort((x, y) => y[1] - x[1])[0]![0];

    // Old days are written like extension 0.1.1 (no field); recent ones always carry it.
    for (const a of data.activity) {
      if (local(a).date <= legacyUntil) expect(a).not.toHaveProperty('meetingSeconds');
      else expect(a).toHaveProperty('meetingSeconds');
    }

    // Daily 09:30–10:00 on every recent past weekday, for everyone with data that day.
    const recentDays = new Set(data.activity.map((a) => local(a).date).filter((d) => d > legacyUntil && d < today));
    expect(recentDays.size).toBeGreaterThanOrEqual(3);
    for (const date of recentDays) {
      for (const p of PEOPLE) {
        const uid = UIDS[p.key as keyof typeof UIDS];
        const daily = data.activity.filter((a) => a.uid === uid && local(a).date === date && local(a).hour === 9 && local(a).minute >= 30);
        if (!data.activity.some((a) => a.uid === uid && local(a).date === date)) continue;
        expect(daily, `${p.key} ${date}`).toHaveLength(3);
        for (const a of daily) {
          expect(mostlyMeeting(a)).toBe(true);
          expect(topDomain(a)).toBe('meet.google.com');
        }
      }
    }

    // Ana's weekly 1-hour meeting: Monday 2026-09-28, 15:00–16:00 (6 blocks).
    const weekly = data.activity.filter((a) => a.uid === 'u-ana' && local(a).date === '2026-09-28' && local(a).hour === 15);
    expect(weekly).toHaveLength(6);
    for (const a of weekly) expect(mostlyMeeting(a)).toBe(true);
    const meetingSeconds = weekly.reduce((n, a) => n + (a.meetingSeconds ?? 0), 0);
    expect(meetingSeconds).toBeGreaterThan(45 * 60);
    expect(meetingSeconds).toBeLessThanOrEqual(3600);

    // Most blocks are not meetings.
    const withMeeting = data.activity.filter((a) => (a.meetingSeconds ?? 0) > 0).length;
    expect(withMeeting).toBeGreaterThan(15);
    expect(withMeeting).toBeLessThan(data.activity.length / 2);
  });

  it('uses typical sites and mock-ups are blurred', () => {
    const domains = new Set(data.activity.flatMap((a) => Object.keys(a.domains)));
    for (const d of ['mail.google.com', 'docs.google.com', 'sheets.google.com', 'drive.google.com', 'calendar.google.com', 'meet.google.com']) {
      expect(domains.has(d)).toBe(true);
    }
    expect(Object.keys(SITES).length).toBeGreaterThan(5);
    expect(PEOPLE).toHaveLength(3);
    expect(mockScreenHtml('mail')).toContain('filter:blur(');
  });
});
