import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  CHILE_HOLIDAY_DATES,
  activityDocId,
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

// ---------- anything else ----------

describe('unknown collections', () => {
  it('are denied, even for admin', async () => {
    await assertFails(db('admin').doc('otra/cosa').set({ a: 1 }));
    await assertFails(db('admin').doc('otra/cosa').get());
  });
});
