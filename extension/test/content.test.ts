import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildManifest, DEV_EXTENSION_ID, DEV_PUBLIC_KEY, ICONS } from '../build/manifest';
import { extensionIdFromKey, STORE_EXTENSION_ID, STORE_PUBLIC_KEY } from '../build/store-key';

/** Minimal page globals for the content script (node environment). */
function installPage() {
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const sent: unknown[] = [];
  const runtime: { id: string | undefined; sendMessage: (m: unknown) => Promise<unknown> } = {
    id: 'ext',
    sendMessage: async (m: unknown) => {
      sent.push(m);
    },
  };
  Object.assign(globalThis, {
    window: win,
    document: { visibilityState: 'visible' },
    chrome: { runtime },
  });
  return { win, sent, runtime };
}

function trusted(type: string): Event {
  const e = new Event(type);
  Object.defineProperty(e, 'isTrusted', { value: true });
  return e;
}

async function loadScript(): Promise<void> {
  vi.resetModules();
  await import('../src/content/activity');
}

describe('content script', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const k of ['window', 'document', 'chrome']) delete (globalThis as Record<string, unknown>)[k];
  });

  it('says hello and sends only a timestamp, at most once per second', async () => {
    const page = installPage();
    await loadScript();
    expect(page.sent).toEqual([{ type: 'hello' }]);
    page.win.dispatchEvent(trusted('keydown'));
    page.win.dispatchEvent(trusted('mousemove'));
    vi.advanceTimersByTime(500);
    page.win.dispatchEvent(trusted('touchstart'));
    vi.advanceTimersByTime(600);
    page.win.dispatchEvent(trusted('wheel'));
    expect(page.sent).toEqual([
      { type: 'hello' },
      { type: 'activity', t: 1_790_000_000_000 },
      { type: 'activity', t: 1_790_000_001_100 },
    ]);
  });

  it('ignores scroll: pages scroll themselves with trusted events (auto-scroll is not user input)', async () => {
    const page = installPage();
    await loadScript();
    page.win.dispatchEvent(trusted('scroll'));
    vi.advanceTimersByTime(1_500);
    page.win.dispatchEvent(trusted('scroll'));
    expect(page.sent).toEqual([{ type: 'hello' }]);
  });

  it('ignores synthetic events and hidden pages', async () => {
    const page = installPage();
    await loadScript();
    page.win.dispatchEvent(new Event('keydown'));
    (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
    page.win.dispatchEvent(trusted('keydown'));
    expect(page.sent).toEqual([{ type: 'hello' }]);
  });

  it('detaches silently when the extension context is invalidated', async () => {
    const page = installPage();
    await loadScript();
    page.runtime.sendMessage = () => {
      throw new Error('Extension context invalidated.');
    };
    expect(() => page.win.dispatchEvent(trusted('keydown'))).not.toThrow();
    page.runtime.id = undefined;
    vi.advanceTimersByTime(2_000);
    expect(() => page.win.dispatchEvent(trusted('keydown'))).not.toThrow();
  });

  it('a second injection takes over and the first copy goes quiet', async () => {
    const page = installPage();
    await loadScript();
    await loadScript();
    page.sent.length = 0;
    page.win.dispatchEvent(trusted('mousedown'));
    expect(page.sent).toEqual([{ type: 'activity', t: 1_790_000_000_000 }]);
  });
});

describe('manifest', () => {
  it('dev: MV3 module worker, permissions, content script, fixed key', () => {
    const m = buildManifest({ appEnv: 'dev', version: '1.2.3' });
    expect(m.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(m.permissions).toEqual(['storage', 'unlimitedStorage', 'alarms', 'idle', 'tabs', 'identity', 'scripting']);
    expect(m.icons).toEqual(ICONS);
    expect(m.action?.default_icon).toEqual(ICONS);
    expect(m.action?.default_popup).toBe('popup.html');
    expect(m.host_permissions).toEqual(['<all_urls>']);
    expect(m.incognito).toBe('not_allowed');
    expect(m.content_scripts).toEqual([
      { matches: ['<all_urls>'], js: ['content.js'], all_frames: false, run_at: 'document_start' },
    ]);
    expect(m.key).toBe(DEV_PUBLIC_KEY);
  });

  it('prod: no key, oauth2 only when configured', () => {
    expect(buildManifest({ appEnv: 'prod', version: '1' }).key).toBeUndefined();
    expect(buildManifest({ appEnv: 'prod', version: '1' }).oauth2).toBeUndefined();
    expect(buildManifest({ appEnv: 'prod', version: '1', oauthClientId: 'abc.apps.googleusercontent.com' }).oauth2)
      .toEqual({ client_id: 'abc.apps.googleusercontent.com', scopes: ['openid', 'email', 'profile'] });
  });

  it('qa: prod manifest plus the store key', () => {
    const opts = { appEnv: 'prod', version: '1', oauthClientId: 'abc.apps.googleusercontent.com' } as const;
    const qa = buildManifest({ ...opts, publicKey: STORE_PUBLIC_KEY });
    expect(qa.key).toBe(STORE_PUBLIC_KEY);
    const { key: _key, ...rest } = qa;
    expect(rest).toEqual(buildManifest(opts));
    // Dev always keeps its own key.
    expect(buildManifest({ appEnv: 'dev', version: '1', publicKey: STORE_PUBLIC_KEY }).key).toBe(DEV_PUBLIC_KEY);
  });
});

describe('extensionIdFromKey', () => {
  it('derives the Chrome extension ID from the manifest key', () => {
    expect(extensionIdFromKey(DEV_PUBLIC_KEY)).toBe('klmbbjhphdmmicdbbgkofkpgapcinbmd');
    expect(extensionIdFromKey(DEV_PUBLIC_KEY)).toBe(DEV_EXTENSION_ID);
    expect(extensionIdFromKey(STORE_PUBLIC_KEY)).toBe('egaklokkbnbnccnjicaahaifnkaeobfj');
    expect(STORE_EXTENSION_ID).toBe('egaklokkbnbnccnjicaahaifnkaeobfj');
  });
});
