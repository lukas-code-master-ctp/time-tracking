import { describe, expect, it } from 'vitest';
import {
  activityPercent,
  escapeCsvField,
  formatDateTime,
  formatDuration,
  isSessionLive,
  secondsToHours,
  sessionDurationSeconds,
  summarizeMember,
  summarizeTeam,
  teamSummaryToCsv,
  toCsv,
  type TeamMember,
} from '../src/reports.js';
import { SLOT_MS } from '../src/slots.js';
import type { ActivitySlot, Session } from '../src/types.js';

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0); // 09:00 in Santiago
const MIN = 60_000;

function slot(uid: string, slotStart: number, partial: Partial<ActivitySlot> = {}): ActivitySlot {
  return {
    uid,
    sessionId: 's',
    slotStart,
    trackedSeconds: 600,
    activeSeconds: 300,
    outsideChromeSeconds: 0,
    domains: {},
    urls: [],
    ...partial,
  };
}

function session(uid: string, startedAt: number, endedAt: number | null, lastHeartbeatAt: number): Session {
  return { uid, startedAt, endedAt, endReason: endedAt === null ? null : 'manual', lastHeartbeatAt };
}

function member(uid: string, displayName: string, partial: Partial<TeamMember> = {}): TeamMember {
  return {
    uid,
    email: `${uid}@compratuparcela.cl`,
    displayName,
    photoURL: null,
    role: 'member',
    status: 'active',
    createdAt: T0,
    ...partial,
  };
}

describe('activityPercent', () => {
  it('rounds and handles empty data', () => {
    expect(activityPercent(0, 0)).toBeNull();
    expect(activityPercent(5, 0)).toBeNull();
    expect(activityPercent(1, 3)).toBe(33);
    expect(activityPercent(2, 3)).toBe(67);
    expect(activityPercent(600, 600)).toBe(100);
    expect(activityPercent(700, 600)).toBe(100);
  });
});

describe('sessions', () => {
  it('duration clips to range and uses last heartbeat for open sessions', () => {
    const closed = session('a', T0, T0 + 60 * MIN, T0 + 59 * MIN);
    expect(sessionDurationSeconds(closed)).toBe(3600);
    expect(sessionDurationSeconds(closed, T0 + 30 * MIN)).toBe(1800);
    expect(sessionDurationSeconds(closed, undefined, T0 + 10 * MIN)).toBe(600);
    expect(sessionDurationSeconds(closed, T0 + 2 * 60 * MIN)).toBe(0);
    const open = session('a', T0, null, T0 + 20 * MIN);
    expect(sessionDurationSeconds(open)).toBe(1200);
    const weird = session('a', T0, null, T0 - MIN);
    expect(sessionDurationSeconds(weird)).toBe(0);
  });

  it('isSessionLive requires an open session with a recent heartbeat', () => {
    const open = session('a', T0, null, T0 + 10 * MIN);
    expect(isSessionLive(open)).toBe(true);
    expect(isSessionLive(open, T0 + 40 * MIN)).toBe(true);
    expect(isSessionLive(open, T0 + 41 * MIN)).toBe(false);
    expect(isSessionLive(session('a', T0, T0 + MIN, T0 + MIN), T0 + MIN)).toBe(false);
  });
});

describe('summarizeMember', () => {
  it('aggregates slots and sessions', () => {
    const slots = [
      slot('a', T0, {
        activeSeconds: 450,
        outsideChromeSeconds: 100,
        domains: { 'docs.google.com': 400, 'mail.google.com': 100 },
        urls: [
          { url: 'https://docs.google.com/d/1', seconds: 400 },
          { url: 'https://mail.google.com/mail/u/0/', seconds: 100 },
        ],
      }),
      slot('a', T0 + SLOT_MS, {
        trackedSeconds: 300,
        activeSeconds: 150,
        domains: { 'mail.google.com': 300 },
        urls: [{ url: 'https://mail.google.com/mail/u/0/', seconds: 300 }],
      }),
    ];
    const sessions = [session('a', T0, null, T0 + 15 * MIN)];
    const s = summarizeMember(slots, sessions, { now: T0 + 16 * MIN });
    expect(s).toEqual({
      trackedSeconds: 900,
      activeSeconds: 600,
      activityPercent: 67,
      outsideChromeSeconds: 100,
      sessionSeconds: 900,
      sessionCount: 1,
      inSession: true,
      lastActivityAt: T0 + 15 * MIN,
      slotCount: 2,
      topDomains: [
        { domain: 'mail.google.com', seconds: 400 },
        { domain: 'docs.google.com', seconds: 400 },
      ].sort((x, y) => y.seconds - x.seconds || x.domain.localeCompare(y.domain)),
      topUrls: [
        { url: 'https://docs.google.com/d/1', seconds: 400 },
        { url: 'https://mail.google.com/mail/u/0/', seconds: 400 },
      ],
    });
  });

  it('filters by range and clamps inconsistent slot values', () => {
    const slots = [
      slot('a', T0 - SLOT_MS),
      slot('a', T0, { trackedSeconds: 100, activeSeconds: 500, outsideChromeSeconds: 900 }),
      slot('a', T0 + SLOT_MS),
    ];
    const s = summarizeMember(slots, [], { from: T0, to: T0 + SLOT_MS });
    expect(s).toMatchObject({ trackedSeconds: 100, activeSeconds: 100, outsideChromeSeconds: 100, activityPercent: 100, slotCount: 1 });
    expect(s.inSession).toBe(false);
    expect(s.lastActivityAt).toBe(T0 + 100_000);
  });

  it('handles an empty member', () => {
    expect(summarizeMember([], [])).toMatchObject({
      trackedSeconds: 0,
      activityPercent: null,
      sessionCount: 0,
      inSession: false,
      lastActivityAt: null,
      topDomains: [],
      topUrls: [],
    });
  });

  it('counts only sessions overlapping the range', () => {
    const sessions = [
      session('a', T0 - 3 * 60 * MIN, T0 - 2 * 60 * MIN, T0 - 2 * 60 * MIN),
      session('a', T0 - 30 * MIN, T0 + 30 * MIN, T0 + 30 * MIN),
      session('a', T0 + 5 * 60 * MIN, T0 + 6 * 60 * MIN, T0 + 6 * 60 * MIN),
    ];
    const s = summarizeMember([], sessions, { from: T0, to: T0 + 60 * MIN });
    expect(s.sessionCount).toBe(1);
    expect(s.sessionSeconds).toBe(1800);
  });

  it('limits top lists to topN', () => {
    const domains: Record<string, number> = {};
    for (let i = 0; i < 15; i++) domains[`d${i}.com`] = i + 1;
    const s = summarizeMember([slot('a', T0, { domains })], [], { topN: 3 });
    expect(s.topDomains.map((d) => d.domain)).toEqual(['d14.com', 'd13.com', 'd12.com']);
  });
});

describe('summarizeTeam', () => {
  it('builds one row per member sorted by name with totals', () => {
    const members = [member('b', 'Benjamín'), member('a', 'Álvaro'), member('c', '', { status: 'disabled' })];
    const slots = [slot('a', T0), slot('b', T0, { activeSeconds: 600 }), slot('zzz', T0)];
    const sessions = [session('a', T0, null, T0 + 9 * MIN), session('b', T0, T0 + 10 * MIN, T0 + 10 * MIN)];
    const team = summarizeTeam(members, slots, sessions, { now: T0 + 10 * MIN });
    expect(team.rows.map((r) => r.uid)).toEqual(['a', 'b', 'c']);
    expect(team.rows[2]?.displayName).toBe('c@compratuparcela.cl');
    expect(team.rows[0]).toMatchObject({ inSession: true, activityPercent: 50, trackedSeconds: 600 });
    expect(team.rows[1]).toMatchObject({ inSession: false, activityPercent: 100 });
    expect(team.rows[2]).toMatchObject({ trackedSeconds: 0, activityPercent: null, status: 'disabled' });
    expect(team.totals).toEqual({
      members: 3,
      membersInSession: 1,
      trackedSeconds: 1200,
      activeSeconds: 900,
      activityPercent: 75,
      outsideChromeSeconds: 0,
      sessionSeconds: 540 + 600,
    });
  });
});

describe('CSV', () => {
  it('escapes separators, quotes and newlines', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('cr\rhere')).toBe('"cr\rhere"');
    expect(escapeCsvField('a;b')).toBe('a;b');
    expect(escapeCsvField('a;b', ';')).toBe('"a;b"');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
    expect(escapeCsvField(12.5)).toBe('12.5');
    expect(escapeCsvField(-3)).toBe('-3');
    expect(escapeCsvField(Number.NaN)).toBe('');
    expect(escapeCsvField(true)).toBe('true');
    expect(escapeCsvField('ñandú áéí')).toBe('ñandú áéí');
  });

  it('neutralizes spreadsheet formula injection', () => {
    expect(escapeCsvField('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(escapeCsvField('+1')).toBe("'+1");
    expect(escapeCsvField('-1')).toBe("'-1");
    expect(escapeCsvField('@cmd')).toBe("'@cmd");
    expect(escapeCsvField('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"');
  });

  it('toCsv uses given columns and CRLF', () => {
    const csv = toCsv(
      [
        { name: 'Ana, P.', pct: 50 },
        { name: 'Luis', pct: null },
      ],
      [
        { key: 'name', header: 'Nombre' },
        { key: 'pct', header: 'Actividad (%)' },
      ],
    );
    expect(csv).toBe('Nombre,Actividad (%)\r\n"Ana, P.",50\r\nLuis,\r\n');
  });

  it('toCsv infers columns from rows, supports separator and BOM', () => {
    expect(toCsv([{ a: 1 }, { b: 'x;y', a: 2 }], undefined, { separator: ';', bom: true })).toBe(
      '﻿a;b\r\n1;\r\n2;"x;y"\r\n',
    );
    expect(toCsv([])).toBe('\r\n');
  });

  it('teamSummaryToCsv writes Spanish headers and values', () => {
    const team = summarizeTeam(
      [member('a', 'Ana "La jefa"', { email: 'ana@compratuparcela.cl' })],
      [slot('a', T0, { domains: { 'docs.google.com': 600 } })],
      [session('a', T0, T0 + 90 * MIN, T0 + 90 * MIN)],
      { now: T0 + 100 * MIN },
    );
    const csv = teamSummaryToCsv(team);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe(
      'Nombre,Correo,Estado,Horas en jornada,Horas medidas,Actividad (%),Horas fuera de Chrome,Jornadas,Dominio principal,Última actividad',
    );
    expect(row).toBe('"Ana ""La jefa""",ana@compratuparcela.cl,Fuera de jornada,1.5,0.17,50,0,1,docs.google.com,2026-09-29 10:30');
  });
});

describe('formatting', () => {
  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(59)).toBe('0 min');
    expect(formatDuration(45 * 60)).toBe('45 min');
    expect(formatDuration(3 * 3600 + 5 * 60 + 30)).toBe('3 h 05 min');
    expect(formatDuration(-10)).toBe('0 min');
  });

  it('secondsToHours', () => {
    expect(secondsToHours(5400)).toBe(1.5);
    expect(secondsToHours(600)).toBe(0.17);
    expect(secondsToHours(-1)).toBe(0);
  });

  it('formatDateTime in Santiago', () => {
    expect(formatDateTime(T0)).toBe('2026-09-29 09:00');
    expect(formatDateTime(T0, 'UTC')).toBe('2026-09-29 12:00');
  });
});
