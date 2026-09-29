/**
 * `uploadToStorage()` (fetch to the Storage REST API, used from the service
 * worker where the SDK's XMLHttpRequest does not exist) against the real
 * Auth + Firestore + Storage emulators and storage.rules.
 */
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, signInWithCredential, type Auth } from 'firebase/auth';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMULATOR_PORTS, FIREBASE_DEMO_PROJECT_ID } from '@timetracking/shared';
import { devGoogleIdToken } from '../../src/background/auth';
import { storageObjectExists, uploadToStorage, type FirebaseHandles } from '../../src/background/firebase';

const HOST = '127.0.0.1';
const BUCKET = `${FIREBASE_DEMO_PROJECT_ID}.appspot.com`;
const STORAGE = `http://${HOST}:${EMULATOR_PORTS.storage}`;
const FIRESTORE = `http://${HOST}:${EMULATOR_PORTS.firestore}/v1/projects/${FIREBASE_DEMO_PROJECT_ID}/databases/(default)/documents`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

let auth: Auth;
let uid: string;
let handles: FirebaseHandles;

/** users/{uid} written with the emulator's admin bypass (normally joinOrg does it). */
async function putUser(status: 'active' | 'disabled'): Promise<void> {
  const res = await fetch(`${FIRESTORE}/users/${uid}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        email: { stringValue: 'storage@compratuparcela.cl' },
        role: { stringValue: 'member' },
        status: { stringValue: status },
      },
    }),
  });
  expect(res.ok).toBe(true);
}

function path(name: string, owner = uid): string {
  return `screenshots/${owner}/2026-09-29/${name}-${Date.now()}.jpg`;
}

async function objectMeta(p: string): Promise<{ contentType?: string; size?: string }> {
  const res = await fetch(`${STORAGE}/v0/b/${BUCKET}/o/${encodeURIComponent(p)}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as { contentType?: string; size?: string };
}

beforeAll(async () => {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: FIREBASE_DEMO_PROJECT_ID, storageBucket: BUCKET }, 'storage-test');
  auth = getAuth(app);
  connectAuthEmulator(auth, `http://${HOST}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
  const cred = await signInWithCredential(auth, GoogleAuthProvider.credential(devGoogleIdToken('storage@compratuparcela.cl')));
  uid = cred.user.uid;
  handles = { auth, storageBaseUrl: STORAGE, bucket: BUCKET } as unknown as FirebaseHandles;
  await putUser('active');
});

describe('uploadToStorage (Storage REST + storage.rules)', () => {
  it('uploads a JPEG to the own folder with the ID token; content type and size are kept', async () => {
    const p = path('ok');
    await uploadToStorage(handles, p, JPEG, 'image/jpeg');
    const meta = await objectMeta(p);
    expect(meta.contentType).toBe('image/jpeg');
    expect(Number(meta.size)).toBe(JPEG.byteLength);
  });

  it('accepts a Blob body', async () => {
    const p = path('blob');
    await uploadToStorage(handles, p, new Blob([JPEG], { type: 'image/jpeg' }), 'image/jpeg');
    expect((await objectMeta(p)).contentType).toBe('image/jpeg');
  });

  it('rules rejections map to permission-denied (another uid, not JPEG, overwrite)', async () => {
    await expect(uploadToStorage(handles, path('other', 'someone-else'), JPEG, 'image/jpeg')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(uploadToStorage(handles, path('png'), JPEG, 'image/png')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    const p = path('twice');
    await uploadToStorage(handles, p, JPEG, 'image/jpeg');
    await expect(uploadToStorage(handles, p, JPEG, 'image/jpeg')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('a refused re-upload of an existing file is recognized by the metadata GET (screenshot retries are idempotent)', async () => {
    const p = path('exists');
    expect(await storageObjectExists(handles, p)).toBe(false);
    await uploadToStorage(handles, p, JPEG, 'image/jpeg');
    await expect(uploadToStorage(handles, p, JPEG, 'image/jpeg')).rejects.toMatchObject({ code: 'permission-denied' });
    expect(await storageObjectExists(handles, p)).toBe(true);
    // Files of another uid are not readable: never taken as "ours".
    expect(await storageObjectExists(handles, path('x', 'someone-else'))).toBe(false);
  });

  it('a disabled user cannot upload', async () => {
    await putUser('disabled');
    try {
      await expect(uploadToStorage(handles, path('disabled'), JPEG, 'image/jpeg')).rejects.toMatchObject({
        code: 'permission-denied',
      });
    } finally {
      await putUser('active');
    }
  });

  it('without a signed-in user it fails as unauthenticated (retryable) without calling Storage', async () => {
    const signedOut = { ...handles, auth: { authStateReady: async () => {}, currentUser: null } } as unknown as FirebaseHandles;
    await expect(uploadToStorage(signedOut, path('anon'), JPEG, 'image/jpeg')).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
