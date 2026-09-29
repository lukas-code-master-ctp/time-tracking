import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import type { UserProfile } from '@timetracking/shared';

export const PROJECT_ID = 'demo-timetracking';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Parses "host:port" from an env var set by `firebase emulators:exec`. */
function hostPort(envVar: string, fallbackPort: number): { host: string; port: number } {
  const raw = process.env[envVar];
  if (raw) {
    const idx = raw.lastIndexOf(':');
    const host = raw.slice(0, idx).replace(/^\[|\]$/g, '') || '127.0.0.1';
    const port = Number(raw.slice(idx + 1));
    if (Number.isInteger(port) && port > 0) return { host, port };
  }
  return { host: '127.0.0.1', port: fallbackPort };
}

export async function createEnv(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      ...hostPort('FIRESTORE_EMULATOR_HOST', 8080),
      rules: readFileSync(`${root}firestore.rules`, 'utf8'),
    },
    storage: {
      ...hostPort('FIREBASE_STORAGE_EMULATOR_HOST', 9199),
      rules: readFileSync(`${root}storage.rules`, 'utf8'),
    },
  });
}

export const NOW = 1_790_000_000_000;

export function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    email: 'x@compratuparcela.cl',
    displayName: 'X',
    photoURL: null,
    role: 'member',
    status: 'active',
    createdAt: NOW,
    ...overrides,
  };
}

/**
 * Seed users:
 * - admin: active admin
 * - alice, bob: active members
 * - dave: disabled member
 * - eve: disabled admin (must not be treated as admin)
 * - nodoc: signed in but without `users` doc (not seeded)
 */
export const SEED_USERS: Record<string, UserProfile> = {
  admin: profile({ email: 'admin@compratuparcela.cl', role: 'admin' }),
  alice: profile({ email: 'alice@compratuparcela.cl' }),
  bob: profile({ email: 'bob@compratuparcela.cl' }),
  dave: profile({ email: 'dave@compratuparcela.cl', status: 'disabled' }),
  eve: profile({ email: 'eve@compratuparcela.cl', role: 'admin', status: 'disabled' }),
};

export async function seedUsers(env: RulesTestEnvironment): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await Promise.all(
      Object.entries(SEED_USERS).map(([uid, data]) => db.doc(`users/${uid}`).set(data)),
    );
  });
}

/** Writes arbitrary docs bypassing rules. */
export async function seed(
  env: RulesTestEnvironment,
  docs: Record<string, object>,
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await Promise.all(Object.entries(docs).map(([path, data]) => db.doc(path).set(data)));
  });
}

export function as(env: RulesTestEnvironment, uid: string | null): RulesTestContext {
  return uid === null ? env.unauthenticatedContext() : env.authenticatedContext(uid);
}
