import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  CHILE_HOLIDAY_DATES,
  activityDocId,
  type Absence,
  type Announcement,
  type AnnouncementRead,
  type Celebration,
  type PersonGroup,
  type ActiveBreak,
  type AttendanceSettings,
  type Kiosk,
  type ActivitySlot,
  type DaySchedule,
  type Invitation,
  type OrgConfig,
  type PersonSchedule,
  type ScheduleConfig,
  type ScreenshotMeta,
  type Session,
  type WeekSchedule,
} from '@timetracking/shared';
import { as, createEnv, NOW, profile, seed, seedUsers } from './env.js';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createEnv();
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await seedUsers(env);
});

const db = (uid: string | null) => as(env, uid).firestore();

// ---------- fixtures ----------

function orgConfig(overrides: Partial<OrgConfig> = {}): OrgConfig {
  return {
    allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
    screenshotsEnabled: true,
    blurScreenshots: false,
    screenshotRetentionDays: 90,
    updatedAt: NOW,
    updatedBy: 'admin',
    ...overrides,
  };
}

function session(uid: string, overrides: Partial<Session> = {}): Session {
  return {
    uid,
    startedAt: NOW,
    endedAt: null,
    endReason: null,
    lastHeartbeatAt: NOW,
    ...overrides,
  };
}

const SLOT = 1_790_000_400_000;

function activity(uid: string, overrides: Partial<ActivitySlot> = {}): ActivitySlot {
  return {
    uid,
    sessionId: 's1',
    slotStart: SLOT,
    trackedSeconds: 600,
    activeSeconds: 420,
    outsideChromeSeconds: 60,
    domains: { 'example.com': 540 },
    urls: [{ url: 'https://example.com/a', seconds: 540 }],
    ...overrides,
  };
}

function screenshot(uid: string, overrides: Partial<ScreenshotMeta> = {}): ScreenshotMeta {
  return {
    uid,
    sessionId: 's1',
    takenAt: NOW,
    storagePath: `screenshots/${uid}/2026-09-29/shot1.jpg`,
    blurred: false,
    width: 1280,
    height: 720,
    ...overrides,
  };
}

function invitation(email: string, overrides: Partial<Invitation> = {}): Invitation {
  return {
    email,
    invitedBy: 'admin',
    invitedAt: NOW,
    status: 'pending',
    ...overrides,
  };
}

// ---------- config/org ----------

describe('config/org', () => {
  beforeEach(async () => {
    await seed(env, { 'config/org': orgConfig() });
  });

  it('active member and admin can read it', async () => {
    await assertSucceeds(db('alice').doc('config/org').get());
    await assertSucceeds(db('admin').doc('config/org').get());
  });

  it('disabled user, user without doc and anonymous cannot read it', async () => {
    await assertFails(db('dave').doc('config/org').get());
    await assertFails(db('nodoc').doc('config/org').get());
    await assertFails(db(null).doc('config/org').get());
  });

  it('member cannot write it', async () => {
    await assertFails(
      db('alice').doc('config/org').set(orgConfig({ screenshotsEnabled: false, updatedBy: 'alice' })),
    );
  });

  it('admin can write it', async () => {
    await assertSucceeds(
      db('admin').doc('config/org').set(orgConfig({ screenshotsEnabled: false, updatedAt: NOW + 1 })),
    );
    await assertSucceeds(db('admin').doc('config/org').update({ blurScreenshots: true, updatedAt: NOW + 2 }));
  });

  it('admin write is validated (types, extra fields, updatedBy)', async () => {
    const admin = db('admin');
    await assertFails(admin.doc('config/org').set({ ...orgConfig(), extra: 1 }));
    await assertFails(admin.doc('config/org').set(orgConfig({ updatedBy: 'someone-else' })));
    await assertFails(
      admin.doc('config/org').set({ ...orgConfig(), screenshotRetentionDays: '90' } as unknown as OrgConfig),
    );
    await assertFails(admin.doc('config/org').set(orgConfig({ screenshotRetentionDays: 0 })));
  });

  it('pauseTimerAtLunch is optional and must be a bool', async () => {
    const admin = db('admin');
    await assertSucceeds(admin.doc('config/org').set(orgConfig({ pauseTimerAtLunch: true })));
    await assertSucceeds(admin.doc('config/org').set(orgConfig({ pauseTimerAtLunch: false, updatedAt: NOW + 1 })));
    await assertSucceeds(admin.doc('config/org').set(orgConfig({ updatedAt: NOW + 2 })));
    await assertFails(
      admin.doc('config/org').set({ ...orgConfig(), pauseTimerAtLunch: 'true' } as unknown as OrgConfig),
    );
  });

  it('moodPulseEnabled is optional and must be a bool', async () => {
    const admin = db('admin');
    await assertSucceeds(admin.doc('config/org').set(orgConfig({ moodPulseEnabled: true })));
    await assertFails(admin.doc('config/org').set({ ...orgConfig(), moodPulseEnabled: 1 } as unknown as OrgConfig));
  });

  it('feedbackEnabled is optional and must be a bool', async () => {
    const admin = db('admin');
    await assertSucceeds(admin.doc('config/org').set(orgConfig({ feedbackEnabled: true })));
    await assertFails(admin.doc('config/org').set({ ...orgConfig(), feedbackEnabled: 'si' } as unknown as OrgConfig));
  });

  it('active break settings are optional, with bounded integer minutes', async () => {
    const admin = db('admin');
    await assertSucceeds(
      admin.doc('config/org').set(orgConfig({ activeBreaksEnabled: true, activeBreakIntervalMinutes: 60, activeBreakMinutes: 5 })),
    );
    await assertSucceeds(admin.doc('config/org').set(orgConfig({ activeBreaksEnabled: false, updatedAt: NOW + 1 })));
    await assertSucceeds(
      admin.doc('config/org').set(
        orgConfig({
          activeBreaksEnabled: true,
          activeBreakMode: 'daily',
          activeBreakIntervalMinutes: 60,
          activeBreaksPerDay: 4,
          activeBreakMinutes: 5,
          updatedAt: NOW + 3,
        }),
      ),
    );
    await assertSucceeds(
      admin.doc('config/org').set(
        orgConfig({ activeBreaksEnabled: true, activeBreakMode: 'times', activeBreakTimes: ['11:00', '16:30'], updatedAt: NOW + 4 }),
      ),
    );
    for (const bad of [
      { activeBreakTimes: [] },
      { activeBreakTimes: ['9:00'] },
      { activeBreakTimes: ['24:00'] },
      { activeBreakTimes: ['11:00', '11:60'] },
      { activeBreakTimes: '11:00' },
      { activeBreakTimes: ['11:00,12:00'] },
      { activeBreakTimes: Array.from({ length: 9 }, (_, i) => `1${i}:00`) },
      { activeBreaksEnabled: 'yes' },
      { activeBreakMode: 'weekly' },
      { activeBreaksPerDay: 0 },
      { activeBreaksPerDay: 13 },
      { activeBreaksPerDay: 2.5 },
      { activeBreakIntervalMinutes: 14 },
      { activeBreakIntervalMinutes: 241 },
      { activeBreakIntervalMinutes: 60.5 },
      { activeBreakMinutes: 0 },
      { activeBreakMinutes: 16 },
    ]) {
      await assertFails(admin.doc('config/org').set({ ...orgConfig({ updatedAt: NOW + 2 }), ...bad } as unknown as OrgConfig));
    }
  });

  it('accepts valid domain lists (1 to 10 domains)', async () => {
    const admin = db('admin');
    await assertSucceeds(admin.doc('config/org').set(orgConfig({ allowedDomains: ['compratuparcela.cl'] })));
    await assertSucceeds(
      admin.doc('config/org').set(orgConfig({ allowedDomains: ['impulseai.cl', 'compratuparcela.cl', 'mail.empresa.com'] })),
    );
    const ten = ['compratuparcela.cl', ...Array.from({ length: 9 }, (_, i) => `d${i}.cl`)];
    await assertSucceeds(admin.doc('config/org').set(orgConfig({ allowedDomains: ten })));
  });

  it("rejects a list without the domain of the admin's own account", async () => {
    // admin is admin@compratuparcela.cl (tests/rules/test/env.ts).
    const admin = db('admin');
    await assertFails(admin.doc('config/org').set(orgConfig({ allowedDomains: ['impulseai.cl'] })));
    await assertFails(admin.doc('config/org').update({ allowedDomains: ['impulseai.cl', 'otra.cl'], updatedAt: NOW + 1 }));
    await assertSucceeds(admin.doc('config/org').update({ allowedDomains: ['compratuparcela.cl'], updatedAt: NOW + 1 }));
  });

  it('rejects an empty list, more than 10 domains, duplicates and invalid types', async () => {
    const admin = db('admin');
    const set = (allowedDomains: unknown) =>
      admin.doc('config/org').set({ ...orgConfig(), allowedDomains } as unknown as OrgConfig);
    // Every list below includes the admin's own domain, so each case fails for
    // the reason it tests. Sanity check: the same shape with valid items passes.
    await assertSucceeds(set(['compratuparcela.cl', 'impulseai.cl']));
    await assertFails(set([]));
    await assertFails(set(['compratuparcela.cl', ...Array.from({ length: 10 }, (_, i) => `d${i}.cl`)]));
    await assertFails(set(['compratuparcela.cl', 'compratuparcela.cl']));
    await assertFails(set('impulseai.cl'));
    await assertFails(set({ 0: 'impulseai.cl' }));
    await assertFails(set(null));
    await assertFails(set(['compratuparcela.cl', 42]));
    await assertFails(set(['compratuparcela.cl', null]));
    await assertFails(set(['compratuparcela.cl', { domain: 'impulseai.cl' }]));
    await assertFails(set(['compratuparcela.cl', true]));
    await assertFails(set(['compratuparcela.cl', '']));
    // Must be normalized: lowercase, without '@', a real domain.
    await assertFails(set(['compratuparcela.cl', 'ImpulseAI.cl']));
    await assertFails(set(['compratuparcela.cl', '@impulseai.cl']));
    await assertFails(set(['compratuparcela.cl', 'impulseai']));
    await assertFails(set(['compratuparcela.cl', 'impulse ai.cl']));
    await assertFails(set(['compratuparcela.cl', 'a@impulseai.cl']));
    await assertFails(set(['compratuparcela.cl', 'a..cl']));
    await assertFails(set(['compratuparcela.cl', '-a.cl']));
    await assertFails(set(['compratuparcela.cl', 'a-.cl']));
    await assertFails(set(['compratuparcela.cl', '.a.cl']));
    // Invalid element in the last position also fails.
    await assertFails(set(['compratuparcela.cl', ...Array.from({ length: 8 }, (_, i) => `d${i}.cl`), 'MAL.cl']));
  });

  it('rejects the old single allowedDomain field and missing allowedDomains', async () => {
    const admin = db('admin');
    const withoutList: Partial<OrgConfig> = orgConfig();
    delete withoutList.allowedDomains;
    await assertFails(admin.doc('config/org').set(withoutList as OrgConfig));
    await assertFails(admin.doc('config/org').set({ ...withoutList, allowedDomain: 'compratuparcela.cl' } as unknown as OrgConfig));
    await assertFails(admin.doc('config/org').set({ ...orgConfig(), allowedDomain: 'compratuparcela.cl' } as unknown as OrgConfig));
    await assertFails(admin.doc('config/org').update({ allowedDomains: [] }));
  });

  it('only the "org" doc is writable, and nobody deletes it', async () => {
    await assertFails(db('admin').doc('config/other').set(orgConfig()));
    await assertFails(db('admin').doc('config/org').delete());
  });

  it('disabled admin is not an admin', async () => {
    await assertFails(db('eve').doc('config/org').set(orgConfig({ updatedBy: 'eve' })));
    await assertFails(db('eve').doc('config/org').get());
  });
});

// ---------- config/schedule and schedules/{uid} ----------

const LJ: DaySchedule = { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' };
const WEEK: WeekSchedule = {
  mon: LJ,
  tue: LJ,
  wed: LJ,
  thu: LJ,
  fri: { start: '09:00', end: '14:00', lunchStart: null, lunchEnd: null },
  sat: null,
  sun: null,
};

function scheduleConfig(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    week: WEEK,
    holidays: ['2026-12-25', '2027-01-01'],
    toleranceMinutes: 5,
    remindersEnabled: true,
    updatedAt: NOW,
    updatedBy: 'admin',
    ...overrides,
  };
}

function personSchedule(overrides: Partial<PersonSchedule> = {}): PersonSchedule {
  return { week: { ...WEEK, fri: LJ }, updatedAt: NOW, updatedBy: 'admin', ...overrides };
}

/** Invalid days, each for one reason (the rest of the day is valid). */
const BAD_DAYS: [string, unknown][] = [
  ['start without leading zero', { ...LJ, start: '9:00' }],
  ['hour 24', { ...LJ, end: '24:00' }],
  ['minute 60', { ...LJ, start: '09:60' }],
  ['seconds', { ...LJ, start: '09:00:00' }],
  ['number instead of string', { ...LJ, start: 900 }],
  ['start == end', { ...LJ, start: '18:30' }],
  ['start > end (crosses midnight)', { start: '22:00', end: '06:00', lunchStart: null, lunchEnd: null }],
  ['only lunchStart', { ...LJ, lunchEnd: null }],
  ['only lunchEnd', { ...LJ, lunchStart: null }],
  ['lunch reversed', { ...LJ, lunchStart: '14:00', lunchEnd: '13:00' }],
  ['empty lunch', { ...LJ, lunchStart: '13:00', lunchEnd: '13:00' }],
  ['lunch before start', { ...LJ, lunchStart: '08:00', lunchEnd: '09:30' }],
  ['lunch after end', { ...LJ, lunchStart: '18:00', lunchEnd: '19:00' }],
  ['missing lunch fields', { start: '09:00', end: '18:00' }],
  ['extra field', { ...LJ, note: 'x' }],
  ['not a map', '09:00-18:30'],
  ['list', ['09:00', '18:30']],
];

describe('config/schedule', () => {
  const doc = 'config/schedule';

  it('active member and admin read it; disabled, without doc and anonymous do not', async () => {
    await seed(env, { [doc]: scheduleConfig() });
    await assertSucceeds(db('alice').doc(doc).get());
    await assertSucceeds(db('admin').doc(doc).get());
    await assertFails(db('dave').doc(doc).get());
    await assertFails(db('eve').doc(doc).get());
    await assertFails(db('nodoc').doc(doc).get());
    await assertFails(db(null).doc(doc).get());
  });

  it('an active admin writes it; a member or a disabled admin does not', async () => {
    await assertFails(db('alice').doc(doc).set(scheduleConfig({ updatedBy: 'alice' })));
    await assertFails(db('eve').doc(doc).set(scheduleConfig({ updatedBy: 'eve' })));
    await assertFails(db('nodoc').doc(doc).set(scheduleConfig({ updatedBy: 'nodoc' })));
    await assertSucceeds(db('admin').doc(doc).set(scheduleConfig()));
    await assertSucceeds(db('admin').doc(doc).update({ toleranceMinutes: 10, updatedAt: NOW + 1 }));
    await assertFails(db('alice').doc(doc).update({ toleranceMinutes: 0, updatedBy: 'alice' }));
  });

  it('only an active admin deletes it ("Eliminar horario"); config/org is still never deleted', async () => {
    await seed(env, { [doc]: scheduleConfig(), 'config/org': orgConfig() });
    await assertFails(db('alice').doc(doc).delete());
    await assertFails(db('eve').doc(doc).delete());
    await assertFails(db('nodoc').doc(doc).delete());
    await assertFails(db(null).doc(doc).delete());
    await assertSucceeds(db('admin').doc(doc).delete());
    await assertFails(db('admin').doc('config/org').delete());
    await assertFails(db('admin').doc('config/other').delete());
  });

  it('accepts every day off, the lunch on the borders and the Chilean holidays list', async () => {
    const admin = db('admin');
    const off: WeekSchedule = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
    await assertSucceeds(admin.doc(doc).set(scheduleConfig({ week: off, holidays: [] })));
    const borders: DaySchedule = { start: '00:00', end: '23:59', lunchStart: '00:00', lunchEnd: '23:59' };
    await assertSucceeds(admin.doc(doc).set(scheduleConfig({ week: { ...WEEK, sat: borders } })));
    await assertSucceeds(admin.doc(doc).set(scheduleConfig({ holidays: [...CHILE_HOLIDAY_DATES] })));
    await assertSucceeds(admin.doc(doc).set(scheduleConfig({ toleranceMinutes: 0, remindersEnabled: false })));
    await assertSucceeds(admin.doc(doc).set(scheduleConfig({ toleranceMinutes: 60 })));
  });

  it.each(BAD_DAYS)('rejects an invalid day: %s', async (_why, day) => {
    await assertFails(db('admin').doc(doc).set(scheduleConfig({ week: { ...WEEK, wed: day as DaySchedule } })));
  });

  it('rejects a week without all seven days or with unknown days', async () => {
    const admin = db('admin');
    const { sun: _sun, ...six } = WEEK;
    await assertFails(admin.doc(doc).set({ ...scheduleConfig(), week: six } as unknown as ScheduleConfig));
    await assertFails(admin.doc(doc).set({ ...scheduleConfig(), week: { ...WEEK, lun: null } } as unknown as ScheduleConfig));
    await assertFails(admin.doc(doc).set({ ...scheduleConfig(), week: null } as unknown as ScheduleConfig));
    await assertFails(admin.doc(doc).set({ ...scheduleConfig(), week: [LJ] } as unknown as ScheduleConfig));
  });

  it('rejects invalid holidays (format, types, duplicates, more than 60, hidden commas)', async () => {
    const admin = db('admin');
    const set = (holidays: unknown) => admin.doc(doc).set({ ...scheduleConfig(), holidays } as unknown as ScheduleConfig);
    const sixty = Array.from({ length: 60 }, (_, i) => `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`);
    await assertSucceeds(set(sixty));
    await assertFails(set([...sixty, '2026-12-31']));
    await assertFails(set(['2026-12-25', '2026-12-25']));
    await assertFails(set(['2026-12-5']));
    await assertFails(set(['2026-13-01']));
    await assertFails(set(['2026-12-32']));
    await assertFails(set(['26-12-25']));
    await assertFails(set(['2026/12/25']));
    await assertFails(set(['2026-12-25 ']));
    await assertFails(set([20261225]));
    await assertFails(set([null]));
    await assertFails(set(['2026-12-25', true]));
    await assertFails(set('2026-12-25'));
    await assertFails(set({ 0: '2026-12-25' }));
    // An item holding two dates (joined, it would look like a valid list).
    await assertFails(set(['2026-12-25,2026-12-31']));
    await assertFails(set(['2026-12-25,2026-12-31', '2027-01-01']));
    await assertFails(set(['2026-12-25', '']));
  });

  it('rejects invalid tolerance, reminders, metadata and extra fields', async () => {
    const admin = db('admin');
    const set = (o: object) => admin.doc(doc).set({ ...scheduleConfig(), ...o } as unknown as ScheduleConfig);
    await assertFails(set({ toleranceMinutes: -1 }));
    await assertFails(set({ toleranceMinutes: 61 }));
    await assertFails(set({ toleranceMinutes: 2.5 }));
    await assertFails(set({ toleranceMinutes: '5' }));
    await assertFails(set({ remindersEnabled: 'true' }));
    await assertFails(set({ updatedAt: '1' }));
    await assertFails(set({ updatedBy: 'alice' }));
    await assertFails(set({ extra: 1 }));
    const missing: Partial<ScheduleConfig> = scheduleConfig();
    delete missing.remindersEnabled;
    await assertFails(admin.doc(doc).set(missing as ScheduleConfig));
  });

  it('config/org keeps its own validation (a schedule is not an org config)', async () => {
    await assertFails(db('admin').doc('config/org').set(scheduleConfig() as unknown as OrgConfig));
    await assertFails(db('admin').doc('config/schedule').set(orgConfig() as unknown as ScheduleConfig));
    await assertFails(db('admin').doc('config/other').set(scheduleConfig()));
  });
});

describe('schedules/{uid}', () => {
  it('the person reads their own; another member does not; admins read all', async () => {
    await seed(env, { 'schedules/alice': personSchedule(), 'schedules/bob': personSchedule() });
    await assertSucceeds(db('alice').doc('schedules/alice').get());
    await assertFails(db('alice').doc('schedules/bob').get());
    await assertFails(db('alice').collection('schedules').get());
    await assertSucceeds(db('admin').doc('schedules/bob').get());
    await assertSucceeds(db('admin').collection('schedules').get());
    // Disabled users (even the owner or a disabled admin) and anonymous do not.
    await seed(env, { 'schedules/dave': personSchedule() });
    await assertFails(db('dave').doc('schedules/dave').get());
    await assertFails(db('eve').doc('schedules/alice').get());
    await assertFails(db(null).doc('schedules/alice').get());
  });

  it('a missing exception can be read by its owner (the extension checks it)', async () => {
    await assertSucceeds(db('alice').doc('schedules/alice').get());
    await assertFails(db('alice').doc('schedules/bob').get());
  });

  it('only an active admin writes and deletes it', async () => {
    await assertFails(db('alice').doc('schedules/alice').set(personSchedule({ updatedBy: 'alice' })));
    await assertFails(db('alice').doc('schedules/bob').set(personSchedule({ updatedBy: 'alice' })));
    await assertFails(db('eve').doc('schedules/alice').set(personSchedule({ updatedBy: 'eve' })));
    await assertSucceeds(db('admin').doc('schedules/alice').set(personSchedule()));
    await assertSucceeds(db('admin').doc('schedules/admin').set(personSchedule()));
    await assertSucceeds(db('admin').doc('schedules/alice').update({ week: WEEK, updatedAt: NOW + 1 }));
    await assertFails(db('alice').doc('schedules/alice').delete());
    await assertFails(db('eve').doc('schedules/alice').delete());
    await assertSucceeds(db('admin').doc('schedules/alice').delete());
  });

  it('only for existing users', async () => {
    await assertFails(db('admin').doc('schedules/nobody').set(personSchedule()));
  });

  it('validates the shape: week, updatedBy, no holidays nor tolerance of its own', async () => {
    const admin = db('admin');
    const set = (o: object) => admin.doc('schedules/alice').set({ ...personSchedule(), ...o } as unknown as PersonSchedule);
    await assertFails(set({ updatedBy: 'someone-else' }));
    await assertFails(set({ updatedAt: '1' }));
    await assertFails(set({ holidays: [] }));
    await assertFails(set({ toleranceMinutes: 5 }));
    await assertFails(set({ week: { ...WEEK, mon: { ...LJ, end: '08:00' } } }));
    await assertFails(set({ week: { ...WEEK, mon: { ...LJ, lunchStart: '19:00', lunchEnd: '20:00' } } }));
    await assertFails(set({ week: null }));
    const noWeek: Partial<PersonSchedule> = personSchedule();
    delete noWeek.week;
    await assertFails(admin.doc('schedules/alice').set(noWeek as PersonSchedule));
  });
});

// ---------- invitations ----------

describe('invitations', () => {
  const email = 'nuevo@compratuparcela.cl';

  it('admin creates, reads, updates and deletes invitations', async () => {
    const admin = db('admin');
    await assertSucceeds(admin.doc(`invitations/${email}`).set(invitation(email)));
    await assertSucceeds(admin.doc(`invitations/${email}`).get());
    await assertSucceeds(admin.collection('invitations').get());
    await assertSucceeds(admin.doc(`invitations/${email}`).update({ status: 'revoked' }));
    await assertSucceeds(admin.doc(`invitations/${email}`).delete());
  });

  it('invitation id must be the lowercased email and start pending by the caller', async () => {
    const admin = db('admin');
    await assertFails(admin.doc('invitations/otro@compratuparcela.cl').set(invitation(email)));
    await assertFails(admin.doc(`invitations/${email}`).set(invitation(email, { status: 'accepted' })));
    await assertFails(admin.doc(`invitations/${email}`).set(invitation(email, { invitedBy: 'bob' })));
    await assertFails(admin.doc(`invitations/${email}`).set({ ...invitation(email), extra: true }));
    // Mixed-case email is fine as long as the id is its lowercase form.
    await assertSucceeds(
      admin.doc(`invitations/${email}`).set(invitation('Nuevo@CompraTuParcela.cl')),
    );
  });

  it('re-invite by update records the caller, never someone else', async () => {
    await seed(env, {
      'users/admin2': profile({ email: 'admin2@compratuparcela.cl', role: 'admin' }),
      [`invitations/${email}`]: invitation(email, { status: 'revoked' }),
    });
    await assertFails(
      db('admin').doc(`invitations/${email}`).update({ invitedBy: 'bob', status: 'pending' }),
    );
    await assertFails(db('admin').doc(`invitations/${email}`).update({ email: 'otro@compratuparcela.cl' }));
    await assertSucceeds(
      db('admin2').doc(`invitations/${email}`).update({ invitedBy: 'admin2', invitedAt: NOW + 1, status: 'pending' }),
    );
  });

  it('member, disabled admin and anonymous cannot touch invitations', async () => {
    await seed(env, { [`invitations/${email}`]: invitation(email) });
    for (const uid of ['alice', 'eve', 'nodoc', null]) {
      const c = db(uid);
      await assertFails(c.doc(`invitations/${email}`).get());
      await assertFails(c.collection('invitations').get());
      await assertFails(c.doc('invitations/x@compratuparcela.cl').set(invitation('x@compratuparcela.cl', { invitedBy: uid ?? 'anon' })));
      await assertFails(c.doc(`invitations/${email}`).update({ status: 'revoked' }));
      await assertFails(c.doc(`invitations/${email}`).delete());
    }
  });
});

// ---------- users ----------

describe('users', () => {
  it('member reads own doc but not others, and cannot list', async () => {
    await assertSucceeds(db('alice').doc('users/alice').get());
    await assertFails(db('alice').doc('users/bob').get());
    await assertFails(db('alice').collection('users').get());
  });

  it('user without doc can read own (missing) doc; disabled user reads own doc', async () => {
    await assertSucceeds(db('nodoc').doc('users/nodoc').get());
    await assertSucceeds(db('dave').doc('users/dave').get());
    await assertFails(db(null).doc('users/alice').get());
  });

  it('admin reads and lists all users', async () => {
    await assertSucceeds(db('admin').doc('users/alice').get());
    await assertSucceeds(db('admin').collection('users').get());
  });

  it('disabled admin cannot read other users', async () => {
    await assertFails(db('eve').doc('users/alice').get());
    await assertFails(db('eve').collection('users').get());
  });

  it('nobody creates users docs from the client', async () => {
    await assertFails(db('nodoc').doc('users/nodoc').set(profile()));
    await assertFails(db('admin').doc('users/nuevo').set(profile()));
  });

  it('member cannot change own role or status', async () => {
    await assertFails(db('alice').doc('users/alice').update({ role: 'admin' }));
    await assertFails(db('alice').doc('users/alice').update({ status: 'disabled' }));
    await assertFails(db('alice').doc('users/alice').update({ displayName: 'Otro' }));
  });

  it('member cannot change other users', async () => {
    await assertFails(db('alice').doc('users/bob').update({ role: 'admin' }));
    await assertFails(
      db('alice').doc('users/bob').update({ consentAcceptedAt: NOW, consentVersion: 'v1' }),
    );
  });

  it('member records consent (only consentAcceptedAt number + consentVersion string)', async () => {
    const alice = db('alice');
    await assertSucceeds(
      alice.doc('users/alice').update({ consentAcceptedAt: NOW, consentVersion: '2026-09-29' }),
    );
    await assertFails(alice.doc('users/alice').update({ consentAcceptedAt: 'hoy', consentVersion: 'v1' }));
    await assertFails(alice.doc('users/alice').update({ consentAcceptedAt: NOW, consentVersion: 1 }));
    // First consent must set both fields.
    await assertFails(db('bob').doc('users/bob').update({ consentAcceptedAt: NOW }));
    await assertFails(db('bob').doc('users/bob').update({ consentVersion: 'v1' }));
    await assertFails(
      alice.doc('users/alice').update({ consentAcceptedAt: NOW, consentVersion: 'v2', role: 'admin' }),
    );
  });

  it('disabled user cannot record consent', async () => {
    await assertFails(
      db('dave').doc('users/dave').update({ consentAcceptedAt: NOW, consentVersion: 'v1' }),
    );
  });

  it('admin changes role/status of others, not other fields and not itself', async () => {
    const admin = db('admin');
    await assertSucceeds(admin.doc('users/alice').update({ role: 'admin' }));
    await assertSucceeds(admin.doc('users/bob').update({ status: 'disabled' }));
    await assertFails(admin.doc('users/dave').update({ status: 'banned' }));
    await assertFails(admin.doc('users/dave').update({ email: 'otro@x.cl' }));
    await assertFails(admin.doc('users/admin').update({ role: 'member' }));
  });

  it('disabled admin cannot change users', async () => {
    await assertFails(db('eve').doc('users/alice').update({ role: 'admin' }));
    await assertFails(db('eve').doc('users/eve').update({ status: 'active' }));
  });

  it('nobody deletes users', async () => {
    await assertFails(db('admin').doc('users/alice').delete());
    await assertFails(db('alice').doc('users/alice').delete());
  });
});

// ---------- sessions ----------

describe('sessions', () => {
  it('member creates an open session of its own', async () => {
    await assertSucceeds(db('alice').doc('sessions/s1').set(session('alice')));
  });

  it('session create is validated', async () => {
    const alice = db('alice');
    await assertFails(alice.doc('sessions/s1').set(session('bob')));
    await assertFails(alice.doc('sessions/s1').set(session('alice', { endedAt: NOW, endReason: 'manual' })));
    await assertFails(alice.doc('sessions/s1').set({ ...session('alice'), extra: 1 }));
    await assertFails(
      alice.doc('sessions/s1').set({ ...session('alice'), startedAt: 'ahora' } as unknown as Session),
    );
    const { lastHeartbeatAt: _omit, ...missing } = session('alice');
    await assertFails(alice.doc('sessions/s1').set(missing));
  });

  it('member updates heartbeat and closes own session', async () => {
    await seed(env, { 'sessions/s1': session('alice') });
    const alice = db('alice');
    await assertSucceeds(alice.doc('sessions/s1').update({ lastHeartbeatAt: NOW + 60_000 }));
    await assertSucceeds(
      alice.doc('sessions/s1').update({ endedAt: NOW + 120_000, endReason: 'manual', lastHeartbeatAt: NOW + 120_000 }),
    );
  });

  it('member cannot change uid/startedAt or set invalid endReason', async () => {
    await seed(env, { 'sessions/s1': session('alice') });
    const alice = db('alice');
    await assertFails(alice.doc('sessions/s1').update({ uid: 'bob' }));
    await assertFails(alice.doc('sessions/s1').update({ startedAt: NOW - 1000 }));
    await assertFails(alice.doc('sessions/s1').update({ endReason: 'crash', endedAt: NOW }));
    await assertFails(alice.doc('sessions/s1').update({ extra: true }));
  });

  it('member reads own sessions but not others', async () => {
    await seed(env, { 'sessions/s1': session('alice'), 'sessions/s2': session('bob') });
    const alice = db('alice');
    await assertSucceeds(alice.doc('sessions/s1').get());
    await assertFails(alice.doc('sessions/s2').get());
    await assertSucceeds(alice.collection('sessions').where('uid', '==', 'alice').get());
    await assertFails(alice.collection('sessions').get());
    await assertFails(alice.collection('sessions').where('uid', '==', 'bob').get());
  });

  it('closed sessions are immutable (no reopen, no rewriting hours)', async () => {
    await seed(env, {
      'sessions/m': session('alice', { endedAt: NOW + 60_000, endReason: 'manual', lastHeartbeatAt: NOW + 60_000 }),
      'sessions/a': session('alice', { endedAt: NOW + 60_000, endReason: 'auto', lastHeartbeatAt: NOW + 60_000 }),
    });
    const alice = db('alice');
    await assertFails(alice.doc('sessions/m').update({ endedAt: null, endReason: null }));
    await assertFails(alice.doc('sessions/m').update({ endedAt: NOW + 3_600_000 }));
    await assertFails(alice.doc('sessions/m').update({ endReason: 'auto' }));
    // Late heartbeat after autoCloseStaleSessions closed it: rejected.
    await assertFails(alice.doc('sessions/a').update({ lastHeartbeatAt: NOW + 120_000 }));
  });

  it('endedAt/endReason must be coherent and times ordered and not in the future', async () => {
    await seed(env, { 'sessions/s1': session('alice') });
    const alice = db('alice');
    await assertFails(alice.doc('sessions/s1').update({ endedAt: NOW + 1000 }));
    await assertFails(alice.doc('sessions/s1').update({ endReason: 'manual' }));
    await assertFails(alice.doc('sessions/s1').update({ endedAt: NOW - 1000, endReason: 'manual' }));
    await assertFails(alice.doc('sessions/s1').update({ lastHeartbeatAt: NOW - 1000 }));
    await assertFails(alice.doc('sessions/s1').update({ lastHeartbeatAt: Date.now() + 60 * 60_000 }));
    await assertFails(
      alice.doc('sessions/s1').update({ endedAt: Date.now() + 60 * 60_000, endReason: 'manual' }),
    );
    await assertFails(
      alice.doc('sessions/s2').set(session('alice', { startedAt: Date.now() + 60 * 60_000, lastHeartbeatAt: Date.now() + 60 * 60_000 })),
    );
    await assertSucceeds(alice.doc('sessions/s1').update({ endedAt: NOW + 1000, endReason: 'auto', lastHeartbeatAt: NOW + 1000 }));
  });

  it('member lists own sessions by startedAt range; admin lists open sessions', async () => {
    await seed(env, {
      'sessions/s1': session('alice'),
      'sessions/s2': session('bob'),
    });
    await assertSucceeds(
      db('alice').collection('sessions').where('uid', '==', 'alice')
        .where('startedAt', '>=', NOW - 1000).where('startedAt', '<', NOW + 1000).get(),
    );
    await assertFails(db('alice').collection('sessions').where('endedAt', '==', null).get());
    await assertSucceeds(db('admin').collection('sessions').where('endedAt', '==', null).get());
    await assertSucceeds(
      db('admin').collection('sessions').where('startedAt', '>=', NOW - 1000).where('startedAt', '<', NOW + 1000).get(),
    );
  });

  it("member cannot update someone else's session", async () => {
    await seed(env, { 'sessions/s2': session('bob') });
    await assertFails(db('alice').doc('sessions/s2').update({ lastHeartbeatAt: NOW + 1 }));
  });

  it('admin reads all sessions', async () => {
    await seed(env, { 'sessions/s1': session('alice'), 'sessions/s2': session('bob') });
    await assertSucceeds(db('admin').collection('sessions').get());
    await assertSucceeds(db('admin').doc('sessions/s2').get());
  });

  it('disabled user and user without doc cannot write sessions', async () => {
    await seed(env, { 'sessions/d1': session('dave') });
    await assertFails(db('dave').doc('sessions/d2').set(session('dave')));
    await assertFails(db('dave').doc('sessions/d1').update({ lastHeartbeatAt: NOW + 1 }));
    await assertFails(db('nodoc').doc('sessions/n1').set(session('nodoc')));
    await assertFails(db(null).doc('sessions/x').set(session('x')));
  });

  it('disabled admin cannot read all sessions', async () => {
    await seed(env, { 'sessions/s1': session('alice') });
    await assertFails(db('eve').collection('sessions').get());
  });

  it('nobody deletes sessions', async () => {
    await seed(env, { 'sessions/s1': session('alice') });
    await assertFails(db('alice').doc('sessions/s1').delete());
    await assertFails(db('admin').doc('sessions/s1').delete());
  });
});

// ---------- activity ----------

describe('activity', () => {
  const aliceId = activityDocId('alice', SLOT);

  it('member upserts own activity with the deterministic id', async () => {
    const alice = db('alice');
    await assertSucceeds(alice.doc(`activity/${aliceId}`).set(activity('alice', { trackedSeconds: 60, activeSeconds: 30, outsideChromeSeconds: 0 })));
    await assertSucceeds(alice.doc(`activity/${aliceId}`).set(activity('alice')));
    await assertSucceeds(alice.doc(`activity/${aliceId}`).set(activity('alice', { activeSeconds: 500 }), { merge: true }));
  });

  it('docId must be uid_slotStart', async () => {
    const alice = db('alice');
    await assertFails(alice.doc(`activity/alice_${SLOT + 1}`).set(activity('alice')));
    await assertFails(alice.doc('activity/whatever').set(activity('alice')));
    await assertFails(alice.doc(`activity/${activityDocId('bob', SLOT)}`).set(activity('alice')));
  });

  it("member cannot write someone else's activity", async () => {
    await assertFails(db('alice').doc(`activity/${activityDocId('bob', SLOT)}`).set(activity('bob')));
    await seed(env, { [`activity/${activityDocId('bob', SLOT)}`]: activity('bob') });
    await assertFails(
      db('alice').doc(`activity/${activityDocId('bob', SLOT)}`).update({ activeSeconds: 1 }),
    );
  });

  it('activity fields and ranges are validated', async () => {
    const ref = db('alice').doc(`activity/${aliceId}`);
    await assertFails(ref.set({ ...activity('alice'), keystrokes: 10 }));
    await assertFails(ref.set(activity('alice', { trackedSeconds: 601 })));
    await assertFails(ref.set(activity('alice', { trackedSeconds: 100, activeSeconds: 101 })));
    await assertFails(ref.set(activity('alice', { trackedSeconds: 100, outsideChromeSeconds: 101 })));
    await assertFails(ref.set(activity('alice', { activeSeconds: -1 })));
    await assertFails(ref.set({ ...activity('alice'), domains: 'example.com' } as unknown as ActivitySlot));
    await assertFails(
      ref.set(activity('alice', { urls: Array.from({ length: 21 }, (_, i) => ({ url: `https://e.com/${i}`, seconds: 1 })) })),
    );
    const { sessionId: _omit, ...missing } = activity('alice');
    await assertFails(ref.set(missing));
  });

  it('uid is immutable on update', async () => {
    await seed(env, { [`activity/${aliceId}`]: activity('alice') });
    await assertFails(db('alice').doc(`activity/${aliceId}`).update({ uid: 'bob' }));
  });

  it('member reads own activity only; admin reads all', async () => {
    await seed(env, {
      [`activity/${aliceId}`]: activity('alice'),
      [`activity/${activityDocId('bob', SLOT)}`]: activity('bob'),
    });
    await assertSucceeds(db('alice').doc(`activity/${aliceId}`).get());
    await assertFails(db('alice').doc(`activity/${activityDocId('bob', SLOT)}`).get());
    await assertSucceeds(db('alice').collection('activity').where('uid', '==', 'alice').get());
    await assertFails(db('alice').collection('activity').get());
    await assertSucceeds(db('admin').collection('activity').get());
    await assertFails(db('eve').collection('activity').get());
  });

  it('disabled user and user without doc cannot write activity', async () => {
    await assertFails(db('dave').doc(`activity/${activityDocId('dave', SLOT)}`).set(activity('dave')));
    await assertFails(db('nodoc').doc(`activity/${activityDocId('nodoc', SLOT)}`).set(activity('nodoc')));
  });

  it('meetingSeconds is optional: absent (extension 0.1.1) or a valid integer', async () => {
    const ref = db('alice').doc(`activity/${aliceId}`);
    // Absent: the 8 fields of extension 0.1.1 keep being accepted.
    await assertSucceeds(ref.set(activity('alice')));
    await assertSucceeds(ref.set(activity('alice', { meetingSeconds: 0 })));
    await assertSucceeds(ref.set(activity('alice', { trackedSeconds: 600, activeSeconds: 420, meetingSeconds: 180 })));
    await assertSucceeds(ref.set(activity('alice', { trackedSeconds: 600, activeSeconds: 0, meetingSeconds: 600 })));
    // Merge onto a doc without the field.
    await assertSucceeds(ref.set({ meetingSeconds: 100 }, { merge: true }));
  });

  it('meetingSeconds: rejects negative, non integer, wrong type, broken sum and extra fields', async () => {
    const ref = db('alice').doc(`activity/${aliceId}`);
    await assertFails(ref.set(activity('alice', { meetingSeconds: -1 })));
    await assertFails(ref.set(activity('alice', { meetingSeconds: 1.5 })));
    await assertFails(ref.set({ ...activity('alice'), meetingSeconds: '10' } as unknown as ActivitySlot));
    await assertFails(ref.set({ ...activity('alice'), meetingSeconds: null } as unknown as ActivitySlot));
    // 420 active + 181 meeting > 600 tracked.
    await assertFails(ref.set(activity('alice', { trackedSeconds: 600, activeSeconds: 420, meetingSeconds: 181 })));
    await assertFails(ref.set(activity('alice', { trackedSeconds: 0, activeSeconds: 0, outsideChromeSeconds: 0, meetingSeconds: 1 })));
    await assertFails(ref.set({ ...activity('alice', { meetingSeconds: 10 }), meetingCount: 1 } as unknown as ActivitySlot));
    await assertFails(ref.set({ ...activity('alice', { meetingSeconds: 10 }), meetingPlatform: 'meet' } as unknown as ActivitySlot));
    // Merge that breaks the sum on the resulting doc (420 active + 200 > 600).
    await seed(env, { [`activity/${aliceId}`]: activity('alice', { meetingSeconds: 100 }) });
    await assertFails(ref.set({ meetingSeconds: 200 }, { merge: true }));
    await assertFails(ref.set({ activeSeconds: 550 }, { merge: true }));
    await assertSucceeds(ref.set({ activeSeconds: 500 }, { merge: true }));
  });

  it('partial merge on an existing doc is validated against the resulting doc', async () => {
    await seed(env, { [`activity/${aliceId}`]: activity('alice', { trackedSeconds: 300, activeSeconds: 100, outsideChromeSeconds: 0 }) });
    const ref = db('alice').doc(`activity/${aliceId}`);
    await assertSucceeds(ref.set({ trackedSeconds: 360, activeSeconds: 150 }, { merge: true }));
    // Resulting doc would have activeSeconds (400) > trackedSeconds (360).
    await assertFails(ref.set({ activeSeconds: 400 }, { merge: true }));
    await assertFails(ref.set({ keystrokes: 5 }, { merge: true }));
    await assertFails(ref.set({ uid: 'bob' }, { merge: true }));
    await assertFails(ref.set({ slotStart: SLOT + 600_000 }, { merge: true }));
    await assertFails(ref.set({ urls: 'x' }, { merge: true }));
  });

  it('upsert with merge and dotted domain keys (extension sync every ~60 s)', async () => {
    const ref = db('alice').doc(`activity/${aliceId}`);
    await assertSucceeds(
      ref.set(
        activity('alice', { trackedSeconds: 60, activeSeconds: 30, outsideChromeSeconds: 0, domains: { 'docs.google.com': 60 } }),
        { merge: true },
      ),
    );
    await assertSucceeds(
      ref.set(
        activity('alice', { trackedSeconds: 120, activeSeconds: 70, outsideChromeSeconds: 10, domains: { 'docs.google.com': 90, 'mail.google.com': 20 } }),
        { merge: true },
      ),
    );
    const snap = await ref.get();
    const domains = snap.data()?.domains as Record<string, number>;
    if (domains['docs.google.com'] !== 90 || domains['mail.google.com'] !== 20) {
      throw new Error(`unexpected domains ${JSON.stringify(domains)}`);
    }
  });

  it('slotStart must be aligned to 10 min and not in the future', async () => {
    const alice = db('alice');
    const odd = SLOT + 1000;
    await assertFails(alice.doc(`activity/${activityDocId('alice', odd)}`).set(activity('alice', { slotStart: odd })));
    const future = Math.floor((Date.now() + 60 * 60_000) / 600_000) * 600_000;
    await assertFails(
      alice.doc(`activity/${activityDocId('alice', future)}`).set(activity('alice', { slotStart: future })),
    );
    const current = Math.floor(Date.now() / 600_000) * 600_000;
    await assertSucceeds(
      alice.doc(`activity/${activityDocId('alice', current)}`).set(
        activity('alice', { slotStart: current, trackedSeconds: 10, activeSeconds: 5, outsideChromeSeconds: 0 }),
      ),
    );
  });

  it('popup lists own activity of the day; admin lists everyone by range', async () => {
    await seed(env, {
      [`activity/${aliceId}`]: activity('alice'),
      [`activity/${activityDocId('bob', SLOT)}`]: activity('bob'),
    });
    const from = SLOT - 3_600_000;
    const to = SLOT + 3_600_000;
    await assertSucceeds(
      db('alice').collection('activity').where('uid', '==', 'alice')
        .where('slotStart', '>=', from).where('slotStart', '<', to).orderBy('slotStart').get(),
    );
    await assertFails(
      db('alice').collection('activity').where('slotStart', '>=', from).where('slotStart', '<', to).get(),
    );
    await assertSucceeds(
      db('admin').collection('activity').where('slotStart', '>=', from).where('slotStart', '<', to).get(),
    );
    await assertSucceeds(
      db('admin').collection('activity').where('uid', '==', 'bob').where('slotStart', '>=', from).get(),
    );
    // A disabled user still reads its own history.
    await assertSucceeds(db('dave').collection('activity').where('uid', '==', 'dave').get());
  });

  it('nobody deletes activity', async () => {
    await seed(env, { [`activity/${aliceId}`]: activity('alice') });
    await assertFails(db('alice').doc(`activity/${aliceId}`).delete());
    await assertFails(db('admin').doc(`activity/${aliceId}`).delete());
  });
});

// ---------- screenshots (metadata) ----------

describe('screenshots metadata', () => {
  it('member creates own screenshot metadata', async () => {
    await assertSucceeds(db('alice').doc('screenshots/shot1').set(screenshot('alice')));
  });

  it('screenshot metadata is validated', async () => {
    const ref = db('alice').doc('screenshots/shot1');
    await assertFails(ref.set(screenshot('bob')));
    await assertFails(ref.set({ ...screenshot('alice'), extra: 1 }));
    await assertFails(ref.set(screenshot('alice', { storagePath: 'screenshots/bob/2026-09-29/shot1.jpg' })));
    await assertFails(ref.set(screenshot('alice', { storagePath: 'otra/ruta.jpg' })));
    await assertFails(ref.set({ ...screenshot('alice'), blurred: 'no' } as unknown as ScreenshotMeta));
    await assertFails(ref.set(screenshot('alice', { width: 0 })));
  });

  it('uid is immutable; others cannot overwrite', async () => {
    await seed(env, { 'screenshots/shot1': screenshot('alice') });
    await assertFails(db('alice').doc('screenshots/shot1').update({ uid: 'bob' }));
    await assertFails(db('bob').doc('screenshots/shot1').set(screenshot('bob')));
    // Retry with identical metadata (offline queue) is fine...
    await assertSucceeds(db('alice').doc('screenshots/shot1').set(screenshot('alice')));
    // ...but existing metadata cannot be altered.
    await assertFails(db('alice').doc('screenshots/shot1').set(screenshot('alice', { blurred: true })));
    await assertFails(
      db('alice').doc('screenshots/shot1').update({ storagePath: 'screenshots/alice/2026-09-29/otra.jpg' }),
    );
    await assertFails(db('alice').doc('screenshots/shot1').update({ takenAt: NOW - 1000 }));
  });

  it('takenAt cannot be in the future', async () => {
    await assertFails(
      db('alice').doc('screenshots/f').set(screenshot('alice', { takenAt: Date.now() + 60 * 60_000 })),
    );
    await assertSucceeds(db('alice').doc('screenshots/f').set(screenshot('alice', { takenAt: Date.now() })));
  });

  it('member lists own screenshots by time range; admin lists by range', async () => {
    await seed(env, {
      'screenshots/a': screenshot('alice'),
      'screenshots/b': screenshot('bob'),
    });
    await assertSucceeds(
      db('alice').collection('screenshots').where('uid', '==', 'alice')
        .where('takenAt', '>=', NOW - 1000).where('takenAt', '<', NOW + 1000).get(),
    );
    await assertFails(
      db('alice').collection('screenshots').where('takenAt', '>=', NOW - 1000).get(),
    );
    await assertSucceeds(
      db('admin').collection('screenshots').where('takenAt', '>=', NOW - 1000).where('takenAt', '<', NOW + 1000).get(),
    );
  });

  it('member reads own screenshots only; admin reads all', async () => {
    await seed(env, { 'screenshots/a': screenshot('alice'), 'screenshots/b': screenshot('bob') });
    await assertSucceeds(db('alice').doc('screenshots/a').get());
    await assertFails(db('alice').doc('screenshots/b').get());
    await assertSucceeds(db('alice').collection('screenshots').where('uid', '==', 'alice').get());
    await assertFails(db('alice').collection('screenshots').get());
    await assertSucceeds(db('admin').collection('screenshots').get());
    await assertFails(db('eve').doc('screenshots/b').get());
  });

  it('disabled user cannot write; nobody deletes', async () => {
    await assertFails(db('dave').doc('screenshots/d').set(screenshot('dave')));
    await assertFails(db('nodoc').doc('screenshots/n').set(screenshot('nodoc')));
    await seed(env, { 'screenshots/a': screenshot('alice') });
    await assertFails(db('alice').doc('screenshots/a').delete());
    await assertFails(db('admin').doc('screenshots/a').delete());
  });
});

// ---------- breaks (active breaks) ----------

function activeBreak(uid: string, overrides: Partial<ActiveBreak> = {}): ActiveBreak {
  return {
    uid,
    sessionId: 's1',
    status: 'taken',
    promptedAt: NOW,
    answeredAt: NOW + 4 * 60_000,
    start: NOW + 60_000,
    end: NOW + 4 * 60_000,
    exercise: 'cuello',
    ...overrides,
  };
}

describe('breaks', () => {
  it('the owner writes each answer once (a retry with the same data is fine), never changes it', async () => {
    const ref = db('alice').doc(`breaks/alice_${NOW}`);
    await assertSucceeds(ref.set(activeBreak('alice')));
    await assertSucceeds(ref.set(activeBreak('alice')));
    await assertFails(ref.set(activeBreak('alice', { status: 'skipped', start: NOW + 4 * 60_000 })));
    await assertFails(ref.delete());
    await assertFails(db('admin').doc(`breaks/alice_${NOW}`).delete());
    const answered = NOW + 60_000;
    await assertSucceeds(
      db('alice').doc(`breaks/alice_${NOW + 1}`).set(
        activeBreak('alice', { promptedAt: NOW + 1, status: 'postponed', answeredAt: answered, start: answered, end: answered }),
      ),
    );
  });

  it('rejects another uid or id, bad statuses, breaks longer than 15 min or before the reminder', async () => {
    await assertFails(db('bob').doc(`breaks/alice_${NOW}`).set(activeBreak('alice')));
    await assertFails(db('alice').doc(`breaks/alice_${NOW + 5}`).set(activeBreak('alice')));
    await assertFails(db('alice').doc(`breaks/alice_${NOW}`).set(activeBreak('alice', { status: 'done' as ActiveBreak['status'] })));
    await assertFails(db('alice').doc(`breaks/alice_${NOW}`).set(activeBreak('alice', { end: NOW + 60_000 + 16 * 60_000 })));
    await assertFails(db('alice').doc(`breaks/alice_${NOW}`).set(activeBreak('alice', { start: NOW - 1 })));
    await assertFails(db('alice').doc(`breaks/alice_${NOW}`).set(activeBreak('alice', { answeredAt: NOW - 1 })));
    // Not taken: no interval.
    await assertFails(db('alice').doc(`breaks/alice_${NOW}`).set(activeBreak('alice', { status: 'skipped' })));
    await assertFails(db('alice').doc(`breaks/alice_${NOW}`).set({ ...activeBreak('alice'), extra: 1 } as unknown as ActiveBreak));
    await assertFails(db('dave').doc(`breaks/dave_${NOW}`).set(activeBreak('dave')));
  });

  it('member reads own breaks by range; admin reads all', async () => {
    await seed(env, { [`breaks/alice_${NOW}`]: activeBreak('alice'), [`breaks/bob_${NOW}`]: activeBreak('bob') });
    await assertSucceeds(db('alice').doc(`breaks/alice_${NOW}`).get());
    await assertFails(db('alice').doc(`breaks/bob_${NOW}`).get());
    await assertSucceeds(db('alice').collection('breaks').where('uid', '==', 'alice').where('start', '>=', NOW - 1000).get());
    await assertFails(db('alice').collection('breaks').get());
    await assertSucceeds(
      db('admin').collection('breaks').where('uid', '==', 'bob').where('start', '>=', NOW - 1000).where('start', '<', NOW + 1000).get(),
    );
  });
});

// ---------- absences ----------

function absence(uid: string, overrides: Partial<Absence> = {}): Absence {
  return {
    uid,
    type: 'vacation',
    startDate: '2026-11-02',
    endDate: '2026-11-13',
    startTime: null,
    endTime: null,
    note: '',
    createdAt: NOW,
    createdBy: 'admin',
    updatedAt: NOW,
    updatedBy: 'admin',
    ...overrides,
  };
}

describe('absences', () => {
  it('an admin creates, changes and deletes them', async () => {
    const ref = db('admin').doc('absences/a1');
    await assertSucceeds(ref.set(absence('alice')));
    await assertSucceeds(ref.set(absence('alice', { type: 'medical', note: 'Licencia 5 días', endDate: '2026-11-06' })));
    await assertSucceeds(
      ref.set(absence('alice', { type: 'errand', startDate: '2026-11-03', endDate: '2026-11-03', startTime: '09:00', endTime: '11:30' })),
    );
    await assertSucceeds(ref.delete());
  });

  it('members, disabled admins and strangers cannot write them', async () => {
    await assertFails(db('alice').doc('absences/a1').set(absence('alice', { createdBy: 'alice', updatedBy: 'alice' })));
    await assertFails(db('eve').doc('absences/a1').set(absence('alice', { createdBy: 'eve', updatedBy: 'eve' })));
    await assertFails(db(null).doc('absences/a1').set(absence('alice')));
    await seed(env, { 'absences/a1': absence('alice') });
    await assertFails(db('alice').doc('absences/a1').delete());
  });

  it('rejects malformed absences', async () => {
    const put = (a: Partial<Absence> & Record<string, unknown>) => db('admin').doc('absences/a1').set({ ...absence('alice'), ...a });
    await assertFails(put({ uid: 'nobody' }));
    await assertFails(put({ type: 'nap' as Absence['type'] }));
    await assertFails(put({ startDate: '2026-11-14' }));
    await assertFails(put({ startDate: '2026-13-01' }));
    await assertFails(put({ endDate: '2027-11-03' }));
    await assertSucceeds(put({ endDate: '2027-11-02' }));
    // Hours: one day, start < end, both set.
    await assertFails(put({ startTime: '09:00', endTime: '11:00' }));
    await assertFails(put({ startDate: '2026-11-03', endDate: '2026-11-03', startTime: '11:00', endTime: '09:00' }));
    await assertFails(put({ startDate: '2026-11-03', endDate: '2026-11-03', startTime: '09:00', endTime: null }));
    await assertFails(put({ type: 'other', note: '  ' }));
    await assertFails(put({ note: 'x'.repeat(501) }));
    await assertFails(put({ updatedBy: 'alice' }));
    await assertFails(put({ createdBy: 'alice' }));
    await assertFails(put({ extra: 1 }));
  });

  it('an update keeps the person and the creation', async () => {
    await seed(env, { 'absences/a1': absence('alice') });
    const ref = db('admin').doc('absences/a1');
    await assertFails(ref.set(absence('bob')));
    await assertFails(ref.set(absence('alice', { createdAt: NOW + 1 })));
    await assertSucceeds(ref.set(absence('alice', { updatedAt: NOW + 1, note: 'Aprobadas por RR.HH.' })));
  });

  it('the person requests her own absences as pending and withdraws them while pending', async () => {
    const mine = (o: Partial<Absence> = {}) =>
      absence('alice', { status: 'pending', createdBy: 'alice', updatedBy: 'alice', ...o });
    await assertSucceeds(db('alice').doc('absences/r1').set(mine()));
    // Not for someone else, not approved by herself, not on behalf of an admin.
    await assertFails(db('alice').doc('absences/r2').set(mine({ uid: 'bob' })));
    await assertFails(db('alice').doc('absences/r2').set(mine({ status: 'approved' })));
    const { status: _status, ...noStatus } = mine();
    await assertFails(db('alice').doc('absences/r2').set(noStatus));
    await assertFails(db('alice').doc('absences/r2').set(mine({ createdBy: 'admin' })));
    await assertFails(db('alice').doc('absences/r2').set(mine({ updatedAt: NOW + 1 })));
    await assertFails(db('dave').doc('absences/r2').set(absence('dave', { status: 'pending', createdBy: 'dave', updatedBy: 'dave' })));
    // She cannot change it, nor withdraw it once decided.
    await assertFails(db('alice').doc('absences/r1').set(mine({ note: 'otra' })));
    await assertFails(db('bob').doc('absences/r1').delete());
    await assertSucceeds(db('alice').doc('absences/r1').delete());
    await seed(env, { 'absences/r3': mine({ status: 'approved' }), 'absences/r4': absence('alice') });
    await assertFails(db('alice').doc('absences/r3').delete());
    await assertFails(db('alice').doc('absences/r4').delete());
  });

  it('an admin approves or rejects a request', async () => {
    await seed(env, { 'absences/r1': absence('alice', { status: 'pending', createdBy: 'alice', updatedBy: 'alice' }) });
    const decided = (status: Absence['status']) =>
      absence('alice', { status, createdBy: 'alice', updatedBy: 'admin', updatedAt: NOW + 1 });
    await assertSucceeds(db('admin').doc('absences/r1').set(decided('approved')));
    await assertSucceeds(db('admin').doc('absences/r1').set(decided('rejected')));
    await assertFails(db('admin').doc('absences/r1').set(decided('maybe' as never)));
    await assertSucceeds(db('admin').collection('absences').where('status', '==', 'pending').get());
  });

  it('the person reads hers; an admin reads all', async () => {
    await seed(env, { 'absences/a1': absence('alice'), 'absences/b1': absence('bob') });
    await assertSucceeds(db('alice').doc('absences/a1').get());
    await assertFails(db('alice').doc('absences/b1').get());
    await assertSucceeds(db('alice').collection('absences').where('uid', '==', 'alice').get());
    await assertFails(db('alice').collection('absences').get());
    await assertFails(db('dave').doc('absences/a1').get());
    await assertSucceeds(db('admin').collection('absences').where('startDate', '<=', '2026-11-30').get());
  });
});

// ---------- celebrations ----------

function celebration(overrides: Partial<Celebration> = {}): Celebration {
  return {
    displayName: 'Alice',
    birthday: '03-14',
    hireDate: '2022-11-07',
    active: true,
    updatedAt: NOW,
    updatedBy: 'admin',
    ...overrides,
  };
}

describe('celebrations', () => {
  it('an admin records, changes and deletes them', async () => {
    const ref = db('admin').doc('celebrations/alice');
    await assertSucceeds(ref.set(celebration()));
    await assertSucceeds(ref.set(celebration({ birthday: null, hireDate: null, active: false })));
    await assertSucceeds(ref.set(celebration({ birthday: '02-29' })));
    await assertSucceeds(ref.delete());
  });

  it('members, disabled admins and strangers cannot write them', async () => {
    await assertFails(db('alice').doc('celebrations/alice').set(celebration({ updatedBy: 'alice' })));
    await assertFails(db('eve').doc('celebrations/alice').set(celebration({ updatedBy: 'eve' })));
    await assertFails(db(null).doc('celebrations/alice').set(celebration()));
    await seed(env, { 'celebrations/alice': celebration() });
    await assertFails(db('alice').doc('celebrations/alice').delete());
  });

  it('rejects malformed documents', async () => {
    const put = (o: Partial<Celebration> & Record<string, unknown>, id = 'alice') =>
      db('admin').doc(`celebrations/${id}`).set({ ...celebration(), ...o });
    await assertFails(put({}, 'nobody'));
    await assertFails(put({ birthday: '1990-03-14' }));
    await assertFails(put({ birthday: '13-01' }));
    await assertFails(put({ hireDate: '2022-13-07' }));
    await assertFails(put({ active: 'yes' as never }));
    await assertFails(put({ updatedBy: 'alice' }));
    await assertFails(put({ displayName: 'x'.repeat(201) }));
    await assertFails(put({ extra: 1 }));
    // The boss: an existing person, not herself.
    await assertSucceeds(put({ managerUid: 'bob' }));
    await assertSucceeds(put({ managerUid: null }));
    await assertFails(put({ managerUid: 'alice' }));
    await assertFails(put({ managerUid: 'nobody' }));
    await assertFails(put({ managerUid: 5 as never }));
  });

  it('every active person reads them', async () => {
    await seed(env, { 'celebrations/alice': celebration(), 'celebrations/bob': celebration({ displayName: 'Bob' }) });
    await assertSucceeds(db('alice').collection('celebrations').get());
    await assertSucceeds(db('bob').doc('celebrations/alice').get());
    await assertFails(db('dave').collection('celebrations').get());
    await assertFails(db(null).collection('celebrations').get());
  });
});

// ---------- mood pulse ----------

describe('mood pulse', () => {
  const WEEK = '2026-W45';
  /** One answer as the extension sends it: the day added to the vote + one counter. */
  function answer(uid: string, dates: string[], counters: Record<string, number>, week = WEEK) {
    const f = db(uid);
    const b = f.batch();
    b.set(f.doc(`moodVotes/${uid}_${week}`), { uid, week, dates });
    b.set(f.doc(`moodWeeks/${week}`), counters, { merge: true });
    return b.commit();
  }

  it('accepts one answer per person and day, adding one to one counter', async () => {
    await assertSucceeds(answer('alice', ['2026-11-05'], { n4: 1 }));
    await assertSucceeds(answer('bob', ['2026-11-05'], { n4: 2 }));
    await assertSucceeds(answer('alice', ['2026-11-05', '2026-11-06'], { n2: 1 }));
    // Same day again: the vote does not grow.
    await assertFails(answer('alice', ['2026-11-05', '2026-11-06'], { n3: 1 }));
    await assertFails(answer('alice', ['2026-11-06', '2026-11-05'], { n3: 1 }));
  });

  it('rejects counters without a new day, jumps, several counters or other fields', async () => {
    await assertFails(db('alice').doc(`moodWeeks/${WEEK}`).set({ n4: 1 }));
    await assertFails(answer('alice', ['2026-11-05'], { n4: 2 }));
    await assertFails(answer('alice', ['2026-11-05'], { n4: 1, n5: 1 }));
    await assertFails(answer('alice', ['2026-11-05'], { n6: 1 }));
    await assertSucceeds(answer('alice', ['2026-11-05'], { n4: 1 }));
    await assertFails(answer('bob', ['2026-11-05'], { n4: 3 }));
    await assertFails(answer('bob', ['2026-11-05'], { n4: 0 }));
    await assertFails(answer('bob', ['2026-11-05'], { n4: 2, n1: 1 }));
    await assertFails(answer('bob', ['2026-11-05'], { n3: 1 }, '2026-45'));
    await assertFails(answer('dave', ['2026-11-05'], { n3: 1 }));
  });

  it('a vote only grows, belongs to its owner and has valid dates', async () => {
    const vote = (uid: string, dates: string[], week = WEEK) => ({ uid, week, dates });
    await assertFails(db('bob').doc(`moodVotes/alice_${WEEK}`).set(vote('alice', ['2026-11-05'])));
    await assertFails(db('alice').doc(`moodVotes/alice_2026-W46`).set(vote('alice', ['2026-11-05'])));
    await assertFails(db('alice').doc(`moodVotes/alice_${WEEK}`).set(vote('alice', ['2026-11-5'])));
    await assertFails(db('alice').doc(`moodVotes/alice_${WEEK}`).set(vote('alice', ['2026-11-05', '2026-11-06'])));
    await assertSucceeds(db('alice').doc(`moodVotes/alice_${WEEK}`).set(vote('alice', ['2026-11-05'])));
    await assertFails(db('alice').doc(`moodVotes/alice_${WEEK}`).set(vote('alice', ['2026-11-06'])));
    await assertFails(db('alice').doc(`moodVotes/alice_${WEEK}`).delete());
  });

  it('admins read only the counters; nobody reads someone else\'s vote', async () => {
    await seed(env, {
      [`moodWeeks/${WEEK}`]: { n3: 4 },
      [`moodVotes/alice_${WEEK}`]: { uid: 'alice', week: WEEK, dates: ['2026-11-05'] },
    });
    await assertSucceeds(db('admin').collection('moodWeeks').get());
    await assertFails(db('alice').doc(`moodWeeks/${WEEK}`).get());
    await assertSucceeds(db('alice').doc(`moodVotes/alice_${WEEK}`).get());
    await assertFails(db('admin').doc(`moodVotes/alice_${WEEK}`).get());
    await assertFails(db('admin').collection('moodVotes').get());
    await assertFails(db('bob').doc(`moodVotes/alice_${WEEK}`).get());
  });
});

// ---------- anonymous comments ----------

describe('anonymous feedback', () => {
  const WEEK = '2026-W46';
  /** One comment as the extension sends it: the day added to the vote + the comment. */
  function comment(uid: string, dates: string[], data: Record<string, unknown>, week = WEEK) {
    const f = db(uid);
    const b = f.batch();
    b.set(f.doc(`feedbackVotes/${uid}_${week}`), { uid, week, dates });
    b.set(f.collection('feedback').doc(), data);
    return b.commit();
  }
  const ok = { week: WEEK, tone: 'positive', text: 'Buen almuerzo de equipo' };

  it('accepts one comment per person and day', async () => {
    await assertSucceeds(comment('alice', ['2026-11-13'], ok));
    await assertSucceeds(comment('bob', ['2026-11-13'], { ...ok, tone: 'negative' }));
    await assertSucceeds(comment('alice', ['2026-11-13', '2026-11-14'], ok));
    await assertFails(comment('alice', ['2026-11-13', '2026-11-14'], ok));
    await assertFails(comment('alice', ['2026-11-14', '2026-11-13'], ok));
  });

  it('rejects comments without a new day, with a uid or other fields, bad tone, empty or long text', async () => {
    await assertFails(db('alice').collection('feedback').add(ok));
    await assertFails(comment('alice', ['2026-11-13'], { ...ok, uid: 'alice' }));
    await assertFails(comment('alice', ['2026-11-13'], { ...ok, date: '2026-11-13' }));
    await assertFails(comment('alice', ['2026-11-13'], { ...ok, tone: 'neutral' }));
    await assertFails(comment('alice', ['2026-11-13'], { ...ok, text: '' }));
    await assertFails(comment('alice', ['2026-11-13'], { ...ok, text: 'x'.repeat(501) }));
    await assertFails(comment('alice', ['2026-11-13'], { ...ok, week: '2026-W45' }));
    await assertFails(comment('dave', ['2026-11-13'], ok));
    await assertSucceeds(comment('alice', ['2026-11-13'], { ...ok, text: 'x'.repeat(500) }));
  });

  it('admins read and delete comments but never the votes; nobody edits a comment', async () => {
    await seed(env, {
      'feedback/c1': ok,
      [`feedbackVotes/alice_${WEEK}`]: { uid: 'alice', week: WEEK, dates: ['2026-11-13'] },
    });
    await assertSucceeds(db('admin').collection('feedback').get());
    await assertFails(db('alice').collection('feedback').get());
    await assertFails(db('alice').doc('feedback/c1').get());
    await assertFails(db('admin').doc('feedback/c1').update({ text: 'otro' }));
    await assertFails(db('alice').doc('feedback/c1').delete());
    await assertSucceeds(db('alice').doc(`feedbackVotes/alice_${WEEK}`).get());
    await assertFails(db('admin').doc(`feedbackVotes/alice_${WEEK}`).get());
    await assertFails(db('admin').collection('feedbackVotes').get());
    await assertFails(db('alice').doc(`feedbackVotes/alice_${WEEK}`).delete());
    await assertSucceeds(db('admin').doc('feedback/c1').delete());
  });
});

// ---------- anything else ----------

describe('daily reports (minuta diaria)', () => {
  const report = (uid: string, overrides: Record<string, unknown> = {}) => ({
    uid,
    date: '2026-11-13',
    text: '- Visité Maipú.',
    source: 'text',
    transcript: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

  it('the person writes her own report, with the deterministic id', async () => {
    await assertFails(db('alice').doc('dailyReports/alice_2026-11-12').set(report('alice')));
    await assertFails(db('bob').doc('dailyReports/alice_2026-11-13').set(report('alice')));
    await assertFails(db('dave').doc('dailyReports/dave_2026-11-13').set(report('dave')));
    await assertFails(db('alice').doc('dailyReports/alice_2026-11-13').set(report('alice', { text: '' })));
    await assertFails(db('alice').doc('dailyReports/alice_2026-11-13').set(report('alice', { text: 'x'.repeat(4001) })));
    await assertFails(db('alice').doc('dailyReports/alice_2026-11-13').set(report('alice', { transcript: 'hola' })));
    await assertFails(db('alice').doc('dailyReports/alice_2026-11-13').set(report('alice', { extra: 1 })));
    await assertFails(db('alice').doc('dailyReports/alice_2026-11-13').set(report('alice', { updatedAt: Date.now() + 3_600_000 })));
    await assertSucceeds(db('alice').doc('dailyReports/alice_2026-11-13').set(report('alice', { source: 'audio', transcript: 'Hoy fui…' })));
  });

  it('she can correct it the same day, never change createdAt nor delete it', async () => {
    await seed(env, { 'dailyReports/alice_2026-11-13': report('alice') });
    await assertSucceeds(
      db('alice').doc('dailyReports/alice_2026-11-13').set(report('alice', { text: '- Visité Maipú y Pudahuel.', updatedAt: NOW + 60_000 })),
    );
    await assertFails(db('alice').doc('dailyReports/alice_2026-11-13').set(report('alice', { createdAt: NOW + 1, updatedAt: NOW + 60_000 })));
    await assertFails(
      db('alice').doc('dailyReports/alice_2026-11-13').set(report('alice', { updatedAt: NOW + 2 * 24 * 3_600_000 })),
    );
    await assertFails(db('bob').doc('dailyReports/alice_2026-11-13').set(report('alice', { updatedAt: NOW + 60_000 })));
    await assertFails(db('alice').doc('dailyReports/alice_2026-11-13').delete());
  });

  it('admins read every report; a person only hers (also before it exists)', async () => {
    await seed(env, { 'dailyReports/alice_2026-11-13': report('alice') });
    await assertSucceeds(db('admin').collection('dailyReports').get());
    await assertSucceeds(db('alice').doc('dailyReports/alice_2026-11-13').get());
    await assertSucceeds(db('bob').doc('dailyReports/bob_2026-11-13').get());
    await assertFails(db('bob').doc('dailyReports/alice_2026-11-13').get());
    await assertFails(db('bob').collection('dailyReports').get());
    await assertFails(db('alice').doc('dailyReportDrafts/alice_2026-11-13').get());
    await assertFails(db('alice').doc('dailyReportDrafts/alice_2026-11-13').set({ count: 0 }));
  });

  it('config/org accepts the settings', async () => {
    await assertSucceeds(
      db('admin').doc('config/org').set(orgConfig({ dailyReportEnabled: true, dailyReportGroupIds: ['g1', 'g2'] })),
    );
    await assertFails(db('admin').doc('config/org').set(orgConfig({ dailyReportGroupIds: ['g1', 'g1'] })));
    await assertFails(db('admin').doc('config/org').set(orgConfig({ dailyReportEnabled: 'yes' as unknown as boolean })));
  });
});

describe('unknown collections', () => {
  it('are denied, even for admin', async () => {
    await assertFails(db('admin').doc('otra/cosa').set({ a: 1 }));
    await assertFails(db('admin').doc('otra/cosa').get());
  });
});

// ---------- announcements (spec 2026-11-05-comunicados) ----------

function announcement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    title: 'Nuevo reglamento interno',
    body: 'Lee el reglamento actualizado.\nGracias.',
    authorName: 'Recursos Humanos',
    createdAt: NOW,
    createdBy: 'admin',
    archivedAt: null,
    publishAt: NOW,
    audience: ['*'],
    groupIds: [],
    ...overrides,
  };
}

/** Announcement from before 0.2.29 (no publishAt / audience / groupIds). */
function legacyAnnouncement(): Announcement {
  const { publishAt: _p, audience: _a, groupIds: _g, ...rest } = announcement();
  return rest;
}

const FUTURE = Date.now() + 2 * 24 * 60 * 60 * 1000;

function read(uid: string, overrides: Partial<AnnouncementRead> = {}): AnnouncementRead {
  return { announcementId: 'n1', uid, readAt: NOW, ...overrides };
}

describe('announcements', () => {
  it('an admin publishes, archives and deletes them', async () => {
    const ref = db('admin').doc('announcements/n1');
    await assertSucceeds(ref.set(announcement()));
    await assertSucceeds(ref.update({ archivedAt: NOW + 1 }));
    await assertSucceeds(ref.update({ archivedAt: null }));
    // Published text is not edited.
    await assertFails(ref.update({ title: 'Otro' }));
    await assertSucceeds(ref.delete());
  });

  it('members, disabled admins and strangers cannot write them', async () => {
    await assertFails(db('alice').doc('announcements/n1').set(announcement({ createdBy: 'alice' })));
    await assertFails(db('eve').doc('announcements/n1').set(announcement({ createdBy: 'eve' })));
    await assertFails(db(null).doc('announcements/n1').set(announcement()));
    await seed(env, { 'announcements/n1': announcement() });
    await assertFails(db('alice').doc('announcements/n1').update({ archivedAt: NOW }));
    await assertFails(db('alice').doc('announcements/n1').delete());
  });

  it('rejects malformed announcements', async () => {
    const put = (a: Partial<Announcement> & Record<string, unknown>) => db('admin').doc('announcements/n1').set({ ...announcement(), ...a });
    await assertFails(put({ title: '  ' }));
    await assertFails(put({ title: 'x'.repeat(121) }));
    await assertFails(put({ body: '' }));
    await assertFails(put({ body: 'x'.repeat(4001) }));
    await assertFails(put({ authorName: '' }));
    await assertFails(put({ createdBy: 'alice' }));
    await assertFails(put({ archivedAt: NOW }));
    await assertFails(put({ createdAt: Date.now() + 60 * 60 * 1000 }));
    await assertFails(put({ extra: 1 }));
  });

  it('active people read them; disabled ones and strangers do not', async () => {
    await seed(env, { 'announcements/n1': announcement() });
    await assertSucceeds(db('alice').doc('announcements/n1').get());
    await assertSucceeds(
      db('alice').collection('announcements').where('audience', 'array-contains-any', ['*', 'alice']).orderBy('publishAt', 'desc').limit(30).get(),
    );
    await assertFails(db('dave').doc('announcements/n1').get());
    await assertFails(db(null).doc('announcements/n1').get());
  });

  it('a group announcement is read only by its audience (and admins)', async () => {
    await seed(env, { 'announcements/n1': announcement({ audience: ['alice'], groupIds: ['g1'] }), 'announcements/n2': announcement() });
    await assertSucceeds(db('alice').doc('announcements/n1').get());
    await assertFails(db('bob').doc('announcements/n1').get());
    await assertSucceeds(db('admin').doc('announcements/n1').get());
    const q = (uid: string) =>
      db(uid).collection('announcements').where('audience', 'array-contains-any', ['*', uid]).orderBy('publishAt', 'desc').limit(30).get();
    await assertSucceeds(q('alice'));
    await assertSucceeds(q('bob'));
    // Someone else's uid in the query, or no filter (extensions before 0.2.29), is refused.
    await assertFails(db('bob').collection('announcements').where('audience', 'array-contains-any', ['*', 'alice']).get());
    await assertFails(db('bob').collection('announcements').orderBy('createdAt', 'desc').limit(30).get());
    await assertSucceeds(db('admin').collection('announcements').orderBy('createdAt', 'desc').get());
  });

  it('an admin schedules one and edits it until it is sent', async () => {
    const ref = db('admin').doc('announcements/n1');
    await assertSucceeds(ref.set(announcement({ publishAt: FUTURE, audience: ['alice', 'bob'], groupIds: ['g1'] })));
    await assertSucceeds(ref.update({ title: 'Otro', publishAt: FUTURE + 1000, audience: ['alice'], groupIds: ['g2'] }));
    await assertFails(ref.update({ createdBy: 'bob' }));
    await assertFails(ref.update({ publishAt: NOW - 1 }));
    // Sent ones are not edited.
    await assertSucceeds(db('admin').doc('announcements/n2').set(announcement()));
    await assertFails(db('admin').doc('announcements/n2').update({ title: 'Otro' }));
    await assertFails(db('admin').doc('announcements/n2').update({ audience: ['alice'] }));
  });

  it('rejects malformed delivery fields', async () => {
    const put = (a: Record<string, unknown>) => db('admin').doc('announcements/n1').set({ ...announcement(), ...a });
    await assertFails(put({ publishAt: NOW - 1000 }));
    await assertFails(put({ publishAt: NOW + 400 * 24 * 60 * 60 * 1000 }));
    await assertFails(put({ audience: [] }));
    await assertFails(put({ audience: Array.from({ length: 501 }, (_, i) => `u${i}`) }));
    await assertFails(put({ groupIds: 'g1' }));
    // New ones carry the three fields.
    await assertFails(db('admin').doc('announcements/n1').set(legacyAnnouncement()));
  });

  it('old announcements get the new fields once, for everyone', async () => {
    await seed(env, { 'announcements/old': legacyAnnouncement() });
    const ref = db('admin').doc('announcements/old');
    // Only admins see it until it has the fields.
    await assertFails(db('alice').doc('announcements/old').get());
    await assertSucceeds(ref.get());
    await assertFails(ref.update({ publishAt: NOW, audience: ['alice'], groupIds: [] }));
    await assertFails(ref.update({ publishAt: NOW + 5, audience: ['*'], groupIds: [] }));
    await assertFails(db('alice').doc('announcements/old').update({ publishAt: NOW, audience: ['*'], groupIds: [] }));
    await assertSucceeds(ref.update({ publishAt: NOW, audience: ['*'], groupIds: [] }));
    await assertSucceeds(db('alice').doc('announcements/old').get());
  });

  it('the person confirms the reading once, for herself', async () => {
    await seed(env, { 'announcements/n1': announcement() });
    const ref = db('alice').doc('announcementReads/n1_alice');
    await assertSucceeds(ref.set(read('alice')));
    // Same confirmation again (retry) is fine; a different one is not.
    await assertSucceeds(ref.set(read('alice')));
    await assertFails(ref.set(read('alice', { readAt: NOW + 1 })));
    await assertFails(ref.delete());
    // Not for someone else, not under another id, not for a missing announcement, not disabled.
    await assertFails(db('alice').doc('announcementReads/n1_bob').set(read('bob')));
    await assertFails(db('alice').doc('announcementReads/n2_alice').set(read('alice')));
    await assertFails(db('alice').doc('announcementReads/n9_alice').set(read('alice', { announcementId: 'n9' })));
    await assertFails(db('dave').doc('announcementReads/n1_dave').set(read('dave')));
    await assertFails(db('alice').doc('announcementReads/n1_alice2').set({ ...read('alice'), extra: 1 }));
  });

  it('the person lists her own confirmations; an admin lists all of them', async () => {
    await seed(env, { 'announcements/n1': announcement(), 'announcementReads/n1_alice': read('alice'), 'announcementReads/n1_bob': read('bob') });
    await assertSucceeds(db('alice').collection('announcementReads').where('uid', '==', 'alice').get());
    await assertFails(db('alice').collection('announcementReads').get());
    await assertFails(db('alice').doc('announcementReads/n1_bob').get());
    await assertSucceeds(db('admin').collection('announcementReads').get());
  });
});

// ---------- groups (spec 2026-11-13-grupos-y-comunicados-agendados) ----------

function group(overrides: Partial<PersonGroup> = {}): PersonGroup {
  return { name: 'Terreno', memberUids: ['alice', 'bob'], createdAt: NOW, createdBy: 'admin', updatedAt: NOW, updatedBy: 'admin', ...overrides };
}

describe('groups', () => {
  it('an admin creates, edits and deletes them', async () => {
    const ref = db('admin').doc('groups/g1');
    await assertSucceeds(ref.set(group()));
    await assertSucceeds(ref.set(group({ name: 'Ventas', memberUids: ['alice'], updatedAt: NOW + 1 })));
    // createdAt / createdBy stay.
    await assertFails(ref.set(group({ createdAt: NOW + 5 })));
    await assertSucceeds(ref.delete());
  });

  it('rejects malformed groups', async () => {
    const put = (g: Partial<PersonGroup> & Record<string, unknown>) => db('admin').doc('groups/g1').set({ ...group(), ...g });
    await assertFails(put({ name: ' ' }));
    await assertFails(put({ name: 'x'.repeat(61) }));
    await assertFails(put({ memberUids: [] }));
    await assertFails(put({ memberUids: ['alice', 'alice'] }));
    await assertFails(put({ memberUids: Array.from({ length: 501 }, (_, i) => `u${i}`) }));
    await assertFails(put({ updatedBy: 'alice' }));
    await assertFails(put({ createdBy: 'alice' }));
    await assertFails(put({ extra: 1 }));
  });

  it('members and strangers cannot write them', async () => {
    await assertFails(db('alice').doc('groups/g1').set(group({ createdBy: 'alice', updatedBy: 'alice' })));
    await assertFails(db('eve').doc('groups/g1').set(group({ createdBy: 'eve', updatedBy: 'eve' })));
    await seed(env, { 'groups/g1': group() });
    await assertFails(db('alice').doc('groups/g1').delete());
  });

  it('a person reads only the groups she is in; an admin reads all', async () => {
    await seed(env, { 'groups/g1': group(), 'groups/g2': group({ name: 'Oficina', memberUids: ['carol'] }) });
    await assertSucceeds(db('alice').collection('groups').where('memberUids', 'array-contains', 'alice').get());
    await assertSucceeds(db('alice').doc('groups/g1').get());
    await assertFails(db('alice').doc('groups/g2').get());
    await assertFails(db('alice').collection('groups').get());
    await assertSucceeds(db('admin').collection('groups').get());
    await assertFails(db(null).collection('groups').get());
  });
});

// ---------- attendance marks (spec 2026-11-10-marcaciones) ----------

function attendance(overrides: Partial<AttendanceSettings> = {}): AttendanceSettings {
  return { rut: '12345678-5', mode: 'both', updatedAt: NOW, updatedBy: 'admin', ...overrides };
}

const KIOSK_ID = 'a'.repeat(64);

function kiosk(overrides: Partial<Kiosk> = {}): Kiosk {
  return { name: 'Recepción', createdAt: NOW, createdBy: 'admin', revokedAt: null, ...overrides };
}

describe('attendanceSettings', () => {
  it('an admin writes them; the person reads her own', async () => {
    await assertSucceeds(db('admin').doc('attendanceSettings/alice').set(attendance()));
    await assertSucceeds(db('admin').doc('attendanceSettings/alice').set(attendance({ rut: null, mode: 'extension' })));
    await assertSucceeds(db('alice').doc('attendanceSettings/alice').get());
    await assertFails(db('bob').doc('attendanceSettings/alice').get());
    await assertFails(db('alice').collection('attendanceSettings').get());
    await assertSucceeds(db('admin').collection('attendanceSettings').get());
    await assertSucceeds(db('admin').doc('attendanceSettings/alice').delete());
  });

  it('members cannot change their own mode or RUT', async () => {
    await assertFails(db('alice').doc('attendanceSettings/alice').set(attendance({ updatedBy: 'alice' })));
    await assertFails(db('eve').doc('attendanceSettings/alice').set(attendance({ updatedBy: 'eve' })));
  });

  it('rejects malformed documents', async () => {
    const put = (o: Record<string, unknown>, id = 'alice') =>
      db('admin').doc(`attendanceSettings/${id}`).set({ ...attendance(), ...o });
    await assertFails(put({}, 'nobody'));
    await assertFails(put({ rut: '12.345.678-5' }));
    await assertFails(put({ rut: '12345678-k' }));
    await assertFails(put({ mode: 'tablet' }));
    await assertFails(put({ updatedBy: 'bob' }));
    await assertFails(put({ extra: 1 }));
  });

  it('a kiosk-only person cannot open a work day from the extension', async () => {
    await seed(env, { 'attendanceSettings/alice': attendance({ mode: 'kiosk' }) });
    await assertFails(db('alice').doc('sessions/s-k').set(session('alice')));
    await seed(env, { 'attendanceSettings/alice': attendance({ mode: 'both' }) });
    await assertSucceeds(db('alice').doc('sessions/s-k').set(session('alice')));
  });

  it('the extension heartbeats and closes a kiosk work day it joined, without touching the kiosk fields', async () => {
    const t0 = Date.now() - 60_000;
    const kioskSession = { ...session('alice', { startedAt: t0, lastHeartbeatAt: t0 }), source: 'kiosk', kioskId: KIOSK_ID };
    await seed(env, { 'attendanceSettings/alice': attendance({ mode: 'kiosk' }), 'sessions/s-kiosk': kioskSession });
    const ref = db('alice').doc('sessions/s-kiosk');
    await assertSucceeds(ref.get());
    await assertSucceeds(ref.update({ lastHeartbeatAt: Date.now() }));
    await assertFails(ref.update({ source: 'extension' }));
    await assertFails(ref.update({ kioskId: 'otro' }));
    await assertFails(ref.update({ closedByKioskId: KIOSK_ID }));
    await assertFails(db('bob').doc('sessions/s-kiosk').update({ lastHeartbeatAt: Date.now() }));
    await assertSucceeds(ref.update({ endedAt: Date.now(), endReason: 'manual', lastHeartbeatAt: Date.now() }));
  });

  it('nobody creates a kiosk session from the client', async () => {
    await assertFails(db('alice').doc('sessions/s-fake').set({ ...session('alice'), source: 'kiosk', kioskId: KIOSK_ID }));
    await assertFails(db('alice').doc('sessions/s-fake').set({ ...session('alice'), source: 'kiosk' }));
  });
});

describe('attendancePhotos', () => {
  const photo = { uid: 'alice', sessionId: 's1', kind: 'in', at: NOW, date: '2026-11-10', kioskId: KIOSK_ID, path: 'attendancePhotos/alice/2026-11-10/s1-in.jpg' };

  it('only admins read them; nobody writes them from a client', async () => {
    await seed(env, { 'attendancePhotos/s1_in': photo });
    await assertSucceeds(db('admin').doc('attendancePhotos/s1_in').get());
    await assertSucceeds(db('admin').collection('attendancePhotos').where('date', '>=', '2026-11-01').get());
    await assertFails(db('alice').doc('attendancePhotos/s1_in').get());
    await assertFails(db('eve').doc('attendancePhotos/s1_in').get());
    await assertFails(db('admin').doc('attendancePhotos/s2_in').set({ ...photo, sessionId: 's2' }));
    await assertFails(db('alice').doc('attendancePhotos/s2_in').set({ ...photo, sessionId: 's2' }));
    await assertFails(db('admin').doc('attendancePhotos/s1_in').delete());
  });
});

describe('kiosks', () => {
  it('an admin creates, lists, revokes and deletes them', async () => {
    const ref = db('admin').doc(`kiosks/${KIOSK_ID}`);
    await assertSucceeds(ref.set(kiosk()));
    await assertSucceeds(db('admin').collection('kiosks').get());
    await assertSucceeds(ref.update({ revokedAt: NOW }));
    await assertFails(ref.update({ revokedAt: null }));
    await assertSucceeds(ref.delete());
  });

  it('rejects bad ids and fields, and nobody else reads or writes them', async () => {
    await assertFails(db('admin').doc('kiosks/plain-token').set(kiosk()));
    await assertFails(db('admin').doc(`kiosks/${KIOSK_ID}`).set(kiosk({ name: '' })));
    await assertFails(db('admin').doc(`kiosks/${KIOSK_ID}`).set(kiosk({ revokedAt: NOW })));
    await assertFails(db('admin').doc(`kiosks/${KIOSK_ID}`).set({ ...kiosk(), lastUsedAt: NOW }));
    await assertFails(db('admin').doc(`kiosks/${KIOSK_ID}`).set(kiosk({ createdBy: 'bob' })));
    await assertFails(db('alice').doc(`kiosks/${KIOSK_ID}`).set(kiosk({ createdBy: 'alice' })));
    await seed(env, { [`kiosks/${KIOSK_ID}`]: kiosk() });
    await assertFails(db('alice').doc(`kiosks/${KIOSK_ID}`).get());
    await assertFails(db(null).doc(`kiosks/${KIOSK_ID}`).get());
    await assertFails(db('admin').doc(`kiosks/${KIOSK_ID}`).update({ createdAt: 1 }));
  });
});
