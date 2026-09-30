/**
 * Helpers for scripts that talk to the local Firebase emulators (seed, e2e).
 *
 * REST calls use the emulators' `Authorization: Bearer owner` bypass (admin
 * access without rules). Only valid against the emulators: `assertEmulators()`
 * refuses to run when the hosts point anywhere else.
 */
import { EMULATOR_PORTS, FIREBASE_DEMO_PROJECT_ID } from '@timetracking/shared';

export const PROJECT = FIREBASE_DEMO_PROJECT_ID;
export const BUCKET = `${PROJECT}.appspot.com`;
/** BOOTSTRAP_ADMINS in functions/.env.demo-timetracking. */
export const ADMIN_EMAIL = 'lukas@impulseai.cl';
/** ALLOWED_DOMAIN in functions/.env.demo-timetracking (two Workspace organizations). */
export const DOMAINS: readonly string[] = ['impulseai.cl', 'compratuparcela.cl'];

/** Sets the `*_EMULATOR_HOST` variables (Admin SDK) unless already defined. */
export function useEmulatorEnv(): void {
  process.env.FIRESTORE_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.firestore}`;
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.auth}`;
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.storage}`;
  process.env.GCLOUD_PROJECT ??= PROJECT;
}

export const firestoreUrl = (): string => `http://${process.env.FIRESTORE_EMULATOR_HOST}`;
export const authUrl = (): string => `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
export const storageUrl = (): string => `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`;
export const functionsUrl = (): string => `http://127.0.0.1:${EMULATOR_PORTS.functions}`;

const OWNER = { Authorization: 'Bearer owner' };

function isLocal(host: string | undefined): boolean {
  return !!host && /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return true;
  } catch {
    return false;
  }
}

const EMULATOR_VARS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'] as const;

/**
 * Safety net so these scripts never write to a real project: throws unless
 * every `*_EMULATOR_HOST` points to this machine and the project (ours and
 * `GCLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT`, if set) is a `demo-` project,
 * which Firebase never maps to real resources.
 */
export function assertLocalDemo(env: NodeJS.ProcessEnv = process.env, project: string = PROJECT): void {
  if (!project.startsWith('demo-')) throw new Error(`el proyecto ${project} no es demo-*; este script solo corre contra emuladores.`);
  for (const v of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'] as const) {
    const p = env[v];
    if (p && p !== project) throw new Error(`${v}=${p} no es el proyecto demo ${project}; este script solo corre contra emuladores.`);
  }
  for (const v of EMULATOR_VARS) {
    if (!isLocal(env[v])) throw new Error(`${v}=${env[v] ?? ''} no es un emulador local; este script solo corre contra emuladores.`);
  }
}

/**
 * Throws unless the emulators are local and answering. `functions` also
 * checks the Functions emulator (joinOrg, invitation e-mails).
 */
export async function assertEmulators(opts: { functions?: boolean } = {}): Promise<void> {
  assertLocalDemo();
  const checks: [string, string][] = [
    ['Firestore', `${firestoreUrl()}/`],
    ['Auth', `${authUrl()}/`],
    ['Storage', `${storageUrl()}/`],
  ];
  if (opts.functions) checks.push(['Functions', `${functionsUrl()}/`]);
  const down: string[] = [];
  for (const [name, url] of checks) if (!(await reachable(url))) down.push(name);
  if (down.length > 0) {
    throw new Error(
      `los emuladores no responden (${down.join(', ')}). Levántalos con \`npm run emulators\` (o \`npm run emulators:persist\`) en otra terminal.`,
    );
  }
}

/** Deletes every Firestore document and Auth account of the demo project. */
export async function clearEmulators(): Promise<void> {
  assertLocalDemo();
  for (const url of [
    `${firestoreUrl()}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    `${authUrl()}/emulator/v1/projects/${PROJECT}/accounts`,
  ]) {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error(`no se pudo vaciar el emulador (${url}): HTTP ${res.status}`);
  }
}

/** Firestore REST fields → plain values (strings, numbers, booleans, null, maps, arrays). */
export function plainValue(v: Record<string, unknown>): unknown {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return plainFields(((v.mapValue as { fields?: Record<string, unknown> }).fields ?? {}) as Record<string, unknown>);
  if ('arrayValue' in v) {
    return ((v.arrayValue as { values?: Record<string, unknown>[] }).values ?? []).map((x) => plainValue(x));
  }
  return v;
}

export function plainFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, plainValue(v as Record<string, unknown>)]));
}

/** Plain value → Firestore REST value (inverse of `plainValue`; integers stay integers). */
export function restValue(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => restValue(x)) } };
  if (typeof v === 'object') return { mapValue: { fields: restFields(v as Record<string, unknown>) } };
  throw new Error(`valor no soportado: ${String(v)}`);
}

export function restFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, restValue(v)]));
}

/** Creates or replaces a document (admin access, no rules). Emulators only. */
export async function firestoreWrite(path: string, data: Record<string, unknown>): Promise<void> {
  assertLocalDemo();
  const res = await fetch(`${firestoreUrl()}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    method: 'PATCH',
    headers: { ...OWNER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: restFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore ${path}: HTTP ${res.status} ${await res.text()}`);
}

/** All documents of a collection (plain values + `id`). */
export async function firestoreDocs(collection: string): Promise<({ id: string } & Record<string, unknown>)[]> {
  const out: ({ id: string } & Record<string, unknown>)[] = [];
  let pageToken = '';
  do {
    const res = await fetch(
      `${firestoreUrl()}/v1/projects/${PROJECT}/databases/(default)/documents/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`,
      { headers: OWNER },
    );
    if (!res.ok) throw new Error(`Firestore ${collection}: HTTP ${res.status}`);
    const body = (await res.json()) as { documents?: { name: string; fields?: Record<string, unknown> }[]; nextPageToken?: string };
    for (const d of body.documents ?? []) out.push({ id: d.name.split('/').pop()!, ...plainFields(d.fields ?? {}) });
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

/** One document (plain values) or `null`. */
export async function firestoreDoc(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${firestoreUrl()}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, { headers: OWNER });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore ${path}: HTTP ${res.status}`);
  const body = (await res.json()) as { fields?: Record<string, unknown> };
  return plainFields(body.fields ?? {});
}

/** Object names under a Storage prefix. */
export async function storageObjects(prefix: string): Promise<string[]> {
  const res = await fetch(`${storageUrl()}/v0/b/${BUCKET}/o?prefix=${encodeURIComponent(prefix)}`, { headers: OWNER });
  if (!res.ok) throw new Error(`Storage list: HTTP ${res.status}`);
  const body = (await res.json()) as { items?: { name: string }[] };
  return (body.items ?? []).map((i) => i.name);
}

export async function storageMeta(path: string): Promise<{ size: string; contentType: string }> {
  const res = await fetch(`${storageUrl()}/v0/b/${BUCKET}/o/${encodeURIComponent(path)}`, { headers: OWNER });
  if (!res.ok) throw new Error(`Storage ${path}: HTTP ${res.status}`);
  return (await res.json()) as { size: string; contentType: string };
}

export async function deleteStorageObject(path: string): Promise<void> {
  const res = await fetch(`${storageUrl()}/v0/b/${BUCKET}/o/${encodeURIComponent(path)}`, { method: 'DELETE', headers: OWNER });
  if (!res.ok && res.status !== 404) throw new Error(`Storage delete ${path}: HTTP ${res.status}`);
}

/**
 * Uploads a JPEG with the same REST call as the extension
 * (extension/src/background/firebase.ts), with the owner token instead of the
 * collaborator's ID token. Firebase Storage adds a download token to these
 * uploads, which the portal's `getDownloadURL` needs.
 */
export async function uploadJpeg(path: string, jpeg: Uint8Array<ArrayBuffer>): Promise<void> {
  const res = await fetch(`${storageUrl()}/v0/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { ...OWNER, 'Content-Type': 'image/jpeg' },
    body: jpeg,
  });
  if (!res.ok) throw new Error(`subida de ${path}: HTTP ${res.status} ${await res.text()}`);
}

/**
 * Signs in to the Auth emulator with the same fake Google ID token as the dev
 * login of the portal and the extension (`devGoogleIdToken`), so the account
 * (and its uid) is exactly the one those logins get. Idempotent.
 */
export async function devGoogleSignIn(email: string): Promise<{ uid: string; idToken: string }> {
  const e = email.trim().toLowerCase();
  const idToken = JSON.stringify({
    sub: `dev-${e.replace(/[^a-z0-9]/g, '-')}`,
    email: e,
    email_verified: true,
    name: e.slice(0, e.indexOf('@')),
  });
  const res = await fetch(`${authUrl()}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `id_token=${encodeURIComponent(idToken)}&providerId=google.com`,
      requestUri: 'http://localhost',
      returnSecureToken: true,
      returnIdpCredential: true,
    }),
  });
  const body = (await res.json()) as { localId?: string; idToken?: string; error?: { message: string } };
  if (!res.ok || !body.localId || !body.idToken) throw new Error(`login dev de ${e}: ${body.error?.message ?? res.status}`);
  return { uid: body.localId, idToken: body.idToken };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls `fn` until it returns a truthy value; throws after `timeoutMs`. */
export async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`tiempo agotado esperando ${what}`);
    await sleep(400);
  }
}
