import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  activityDocId,
  type ActivitySlot,
  type Invitation,
  type OrgConfig,
  type ScreenshotMeta,
  type Session,
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
    allowedDomain: 'compratuparcela.cl',
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

  it('only the "org" doc is writable, and nobody deletes it', async () => {
    await assertFails(db('admin').doc('config/other').set(orgConfig()));
    await assertFails(db('admin').doc('config/org').delete());
  });

  it('disabled admin is not an admin', async () => {
    await assertFails(db('eve').doc('config/org').set(orgConfig({ updatedBy: 'eve' })));
    await assertFails(db('eve').doc('config/org').get());
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
    await assertSucceeds(db('alice').doc('screenshots/shot1').set(screenshot('alice', { blurred: true })));
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
