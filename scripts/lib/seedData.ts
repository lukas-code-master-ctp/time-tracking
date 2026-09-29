/**
 * Pure generator of realistic demo data for `npm run seed` (no I/O).
 *
 * Working hours in America/Santiago, Monday to Friday, with a lunch break
 * (two sessions per day), variable activity per person and per block, typical
 * Google Workspace sites, time outside Chrome, a forgotten "close" (auto
 * close) and one day off. Today: one open session right now, one closed
 * morning session, one person without data. Deterministic for a given
 * `now` (seeded PRNG per person and day), so re-running the seed on the same
 * day produces the same documents.
 */
import {
  SLOT_MS,
  slotStartOf,
  type ActivitySlot,
  type Session,
  type SessionEndReason,
} from '@timetracking/shared';
import { addDays, startOfDay, weekdayIndex, zonedDate, zonedParts } from '../../portal/src/lib/dates.ts';

const MIN = 60_000;

export type Task = 'mail' | 'docs' | 'sheets' | 'drive' | 'calendar' | 'meet' | 'slides' | 'chat' | 'web' | 'whatsapp' | 'outside';

export interface SeedPerson {
  key: string;
  email: string;
  displayName: string;
  /** Mean activity % and its spread. */
  activity: number;
  spread: number;
  /** Relative weight of each task (how this person works). */
  tasks: Partial<Record<Task, number>>;
}

export const PEOPLE: readonly SeedPerson[] = [
  {
    key: 'ana',
    email: 'ana.rojas@compratuparcela.cl',
    displayName: 'Ana Rojas',
    activity: 78,
    spread: 14,
    tasks: { mail: 3, docs: 3, sheets: 2, drive: 1, calendar: 1, meet: 1, chat: 1, web: 1, outside: 0.6 },
  },
  {
    key: 'beto',
    email: 'beto.diaz@compratuparcela.cl',
    displayName: 'Beto Díaz',
    activity: 55,
    spread: 20,
    tasks: { mail: 2, sheets: 4, drive: 2, meet: 2, calendar: 1, whatsapp: 1.5, web: 1.5, outside: 1.5 },
  },
  {
    key: 'carla',
    email: 'carla.soto@compratuparcela.cl',
    displayName: 'Carla Soto',
    activity: 66,
    spread: 18,
    tasks: { mail: 2, docs: 2, slides: 2, meet: 3, calendar: 2, chat: 1, drive: 1, outside: 1 },
  },
];

export const PENDING_INVITE = 'diego.munoz@compratuparcela.cl';

interface Site {
  domain: string;
  urls: string[];
}

export const SITES: Record<Exclude<Task, 'outside'>, Site[]> = {
  mail: [{ domain: 'mail.google.com', urls: ['https://mail.google.com/mail/u/0/', 'https://mail.google.com/mail/u/1/'] }],
  docs: [
    {
      domain: 'docs.google.com',
      urls: [
        'https://docs.google.com/document/d/1informe-ventas-septiembre/edit',
        'https://docs.google.com/document/d/1contrato-promesa-parcela-12/edit',
        'https://docs.google.com/document/d/1minuta-reunion-comercial/edit',
      ],
    },
  ],
  sheets: [
    {
      domain: 'sheets.google.com',
      urls: ['https://sheets.google.com/', 'https://sheets.google.com/u/0/'],
    },
    {
      domain: 'docs.google.com',
      urls: [
        'https://docs.google.com/spreadsheets/d/1pipeline-clientes-2026/edit',
        'https://docs.google.com/spreadsheets/d/1stock-parcelas-sur/edit',
      ],
    },
  ],
  drive: [{ domain: 'drive.google.com', urls: ['https://drive.google.com/drive/my-drive', 'https://drive.google.com/drive/folders/1proyectos-2026'] }],
  calendar: [{ domain: 'calendar.google.com', urls: ['https://calendar.google.com/calendar/u/0/r/week'] }],
  meet: [{ domain: 'meet.google.com', urls: ['https://meet.google.com/abc-defg-hij', 'https://meet.google.com/xyz-uvwx-rst'] }],
  slides: [{ domain: 'docs.google.com', urls: ['https://docs.google.com/presentation/d/1presentacion-directorio/edit'] }],
  chat: [{ domain: 'chat.google.com', urls: ['https://chat.google.com/room/equipo-ventas'] }],
  web: [
    { domain: 'compratuparcela.cl', urls: ['https://compratuparcela.cl/', 'https://compratuparcela.cl/parcelas/los-lagos'] },
    { domain: 'google.com', urls: ['https://www.google.com/search'] },
    { domain: 'sii.cl', urls: ['https://www.sii.cl/servicios_online/'] },
  ],
  whatsapp: [{ domain: 'web.whatsapp.com', urls: ['https://web.whatsapp.com/'] }],
};

/** Typical activity % per task (a video call has little keyboard/mouse). */
const TASK_ACTIVITY: Record<Task, number> = {
  mail: 0,
  docs: 8,
  sheets: 10,
  drive: -5,
  calendar: -8,
  meet: -35,
  slides: 4,
  chat: 0,
  web: -6,
  whatsapp: -4,
  outside: -10,
};

// ---------- PRNG ----------

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rng(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: () => number, lo: number, hi: number): number => lo + r() * (hi - lo);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function pick<T>(r: () => number, weights: [T, number][]): T {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of weights) {
    x -= w;
    if (x <= 0) return v;
  }
  return weights[weights.length - 1]![0];
}

// ---------- local time ----------

/** Instant of `hh:mm` (wall clock in Santiago) on `date`. */
export function atLocal(date: string, hour: number, minute = 0): number {
  const start = startOfDay(date);
  const p = zonedParts(start);
  return start + (hour * 60 + minute - (p.hour * 60 + p.minute)) * MIN;
}

// ---------- output ----------

export interface SeedSession {
  id: string;
  data: Session;
}

export interface SeedShot {
  /** `{uid}_{slotStart}` like the extension. */
  id: string;
  uid: string;
  sessionId: string;
  takenAt: number;
  /** What the (blurred) image shows. */
  task: Task;
}

export interface SeedDataset {
  sessions: SeedSession[];
  activity: ActivitySlot[];
  shots: SeedShot[];
}

interface Span {
  start: number;
  end: number;
  lastHeartbeatAt: number;
  endReason: SessionEndReason | null;
}

/** Sessions (lunch split) of a past weekday. */
function pastDay(person: SeedPerson, date: string, r: () => number): Span[] {
  const inM = atLocal(date, 8, Math.round(between(r, 20, 70)));
  const lunch = atLocal(date, 12, Math.round(between(r, 45, 75)));
  const back = lunch + Math.round(between(r, 45, 70)) * MIN;
  const out = atLocal(date, 17, Math.round(between(r, 25, 95)));
  const spans: Span[] = [
    { start: inM, end: lunch, lastHeartbeatAt: lunch, endReason: 'manual' },
    { start: back, end: out, lastHeartbeatAt: out, endReason: 'manual' },
  ];
  // Beto forgets to close on Wednesdays: the server closes it at the last heartbeat.
  if (person.key === 'beto' && weekdayIndex(date) === 2) spans[1]!.endReason = 'auto';
  return spans;
}

/** Today's sessions (relative to `now`). */
function todaySpans(person: SeedPerson, date: string, now: number): Span[] {
  const hb = now - 30_000;
  if (person.key === 'ana') {
    // Open session "right now" (live in the portal).
    const start = Math.floor((now - 2 * 60 * MIN - 40 * MIN) / MIN) * MIN;
    return [{ start, end: hb, lastHeartbeatAt: hb, endReason: null }];
  }
  if (person.key === 'beto') {
    const start = atLocal(date, 9, 5);
    const end = Math.min(atLocal(date, 12, 40), now - 20 * MIN);
    return end - start >= 30 * MIN ? [{ start, end, lastHeartbeatAt: end, endReason: 'manual' }] : [];
  }
  return [];
}

function slotsOf(person: SeedPerson, uid: string, sessionId: string, span: Span, r: () => number): { slots: ActivitySlot[]; tasks: Task[] } {
  const slots: ActivitySlot[] = [];
  const tasks: Task[] = [];
  const weights = Object.entries(person.tasks) as [Task, number][];
  let task: Task = pick(r, weights);
  for (let s = slotStartOf(span.start); s < span.end; s += SLOT_MS) {
    const from = Math.max(span.start, s);
    const to = Math.min(span.end, s + SLOT_MS);
    let tracked = Math.floor((to - from) / 1000);
    if (tracked <= 0) continue;
    // Now and then a gap without data (computer asleep, browser closed).
    if (r() < 0.03) tracked = Math.floor(tracked * between(r, 0.2, 0.6));
    if (r() > 0.65) task = pick(r, weights);
    const pct = clamp(person.activity + TASK_ACTIVITY[task] + (r() * 2 - 1) * person.spread, 3, 99);
    const active = Math.min(tracked, Math.round((tracked * pct) / 100));
    let outside = task === 'outside' ? Math.round(tracked * between(r, 0.6, 1)) : r() < 0.25 ? Math.round(tracked * between(r, 0.05, 0.3)) : 0;
    outside = Math.min(outside, tracked);
    const inChrome = tracked - outside;
    const domains: Record<string, number> = {};
    const urlSeconds = new Map<string, number>();
    const add = (t: Exclude<Task, 'outside'>, seconds: number): void => {
      if (seconds <= 0) return;
      const site = SITES[t][Math.floor(r() * SITES[t].length)]!;
      domains[site.domain] = (domains[site.domain] ?? 0) + seconds;
      const url = site.urls[Math.floor(r() * site.urls.length)]!;
      urlSeconds.set(url, (urlSeconds.get(url) ?? 0) + seconds);
    };
    if (inChrome > 0) {
      const main: Exclude<Task, 'outside'> = task === 'outside' ? 'mail' : task;
      const other = pick(r, weights.filter(([t]) => t !== 'outside' && t !== main) as [Exclude<Task, 'outside'>, number][]);
      const mainShare = Math.round(inChrome * between(r, 0.6, 0.95));
      add(main, mainShare);
      add(other, inChrome - mainShare);
    }
    slots.push({
      uid,
      sessionId,
      slotStart: s,
      trackedSeconds: tracked,
      activeSeconds: active,
      outsideChromeSeconds: outside,
      domains,
      urls: [...urlSeconds].map(([url, seconds]) => ({ url, seconds })).sort((a, b) => b.seconds - a.seconds),
    });
    tasks.push(task);
  }
  return { slots, tasks };
}

/**
 * Sessions, activity and screenshot plans for the 7 days before today plus
 * today. `uids` maps person key → Firebase uid.
 */
export function buildDataset(now: number, uids: Record<string, string>): SeedDataset {
  const today = zonedDate(now);
  const out: SeedDataset = { sessions: [], activity: [], shots: [] };
  for (const person of PEOPLE) {
    const uid = uids[person.key];
    if (!uid) throw new Error(`falta el uid de ${person.key}`);
    for (let back = 7; back >= 0; back--) {
      const date = addDays(today, -back);
      const r = rng(`${person.key}:${date}`);
      if (back > 0 && weekdayIndex(date) >= 5) continue; // weekend
      if (person.key === 'carla' && back === 2) continue; // day off
      const spans = back === 0 ? todaySpans(person, date, now) : pastDay(person, date, r);
      const dayShots: SeedShot[] = [];
      spans.forEach((span, i) => {
        const sessionId = `seed-${person.key}-${date}-${i + 1}`;
        out.sessions.push({
          id: sessionId,
          data: { uid, startedAt: span.start, endedAt: span.endReason ? span.end : null, endReason: span.endReason, lastHeartbeatAt: span.lastHeartbeatAt },
        });
        const { slots, tasks } = slotsOf(person, uid, sessionId, span, r);
        out.activity.push(...slots);
        // Screenshots only on the two most recent days with data (retention demo, few files).
        if (back <= 1 || (back <= 3 && person.key === 'carla')) {
          slots.forEach((slot, j) => {
            if (r() > 0.18 || tasks[j] === 'outside') return; // outside Chrome → no capture
            const lo = Math.max(slot.slotStart, span.start);
            const hi = Math.min(slot.slotStart + SLOT_MS - 30_000, span.end, now - 60_000);
            if (hi <= lo) return;
            const takenAt = Math.floor(between(r, lo, hi));
            dayShots.push({ id: `${uid}_${slot.slotStart}`, uid, sessionId, takenAt, task: tasks[j]! });
          });
        }
      });
      out.shots.push(...dayShots.slice(0, 4));
    }
  }
  return out;
}
