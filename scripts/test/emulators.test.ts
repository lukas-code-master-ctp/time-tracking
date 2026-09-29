import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertLocalDemo, clearEmulators } from '../lib/emulators';

const LOCAL = {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
};

describe('assertLocalDemo: nunca contra producción', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('accepts local emulators of the demo project', () => {
    expect(() => assertLocalDemo({ ...LOCAL })).not.toThrow();
    expect(() => assertLocalDemo({ ...LOCAL, GCLOUD_PROJECT: 'demo-timetracking' })).not.toThrow();
  });

  it('refuses when an emulator variable is missing or not local', () => {
    expect(() => assertLocalDemo({})).toThrow(/FIRESTORE_EMULATOR_HOST/);
    expect(() => assertLocalDemo({ ...LOCAL, FIREBASE_STORAGE_EMULATOR_HOST: undefined })).toThrow(/STORAGE/);
    expect(() => assertLocalDemo({ ...LOCAL, FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' })).toThrow(/no es un emulador local/);
  });

  it('refuses a real project', () => {
    expect(() => assertLocalDemo({ ...LOCAL, GCLOUD_PROJECT: 'registro-jornada-cp' })).toThrow(/GCLOUD_PROJECT/);
    expect(() => assertLocalDemo({ ...LOCAL, GOOGLE_CLOUD_PROJECT: 'registro-jornada-cp' })).toThrow(/GOOGLE_CLOUD_PROJECT/);
    expect(() => assertLocalDemo({ ...LOCAL }, 'registro-jornada-cp')).toThrow(/no es demo-/);
  });

  it('clearEmulators does not send anything without emulators', async () => {
    for (const k of Object.keys(LOCAL)) vi.stubEnv(k, '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(clearEmulators()).rejects.toThrow(/solo corre contra emuladores/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
