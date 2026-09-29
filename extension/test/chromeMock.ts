/**
 * Hand-written in-memory mock of the `chrome.*` APIs used by the background.
 * `installChrome()` puts a fresh one on `globalThis.chrome` and returns the
 * handle to drive it (browser "world": windows, tabs, idle state).
 */

type Listener = (...args: never[]) => unknown;

export class MockEvent<F extends Listener> {
  listeners: F[] = [];
  addListener(fn: F): void {
    this.listeners.push(fn);
  }
  removeListener(fn: F): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  hasListener(fn: F): boolean {
    return this.listeners.includes(fn);
  }
  dispatch(...args: Parameters<F>): unknown[] {
    return this.listeners.map((l) => l(...args));
  }
}

export interface MockTab {
  id: number;
  url: string;
  active: boolean;
  windowId?: number;
  incognito?: boolean;
  discarded?: boolean;
}

export interface MockWindow {
  id: number;
  focused: boolean;
  incognito?: boolean;
  tabs: MockTab[];
}

export class MockStorageArea {
  data: Record<string, unknown> = {};
  /** Every `set` call, in order (deep copies). */
  setCalls: Record<string, unknown>[] = [];
  failSet = false;

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    const list = keys == null ? Object.keys(this.data) : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of list) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failSet) throw new Error('storage failure');
    const copy = structuredClone(items);
    this.setCalls.push(copy);
    Object.assign(this.data, structuredClone(items));
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete this.data[k];
  }
  async clear(): Promise<void> {
    this.data = {};
  }
}

export function createChromeMock() {
  const world = {
    windows: [] as MockWindow[],
    idleState: 'active' as 'active' | 'idle' | 'locked',
    detectionInterval: 0,
    badgeText: '',
    badgeColor: '' as unknown,
    alarms: new Map<string, chrome.alarms.AlarmCreateInfo>(),
    injected: [] as number[],
    /** tab ids where executeScript fails (chrome://, Web Store). */
    notScriptable: new Set<number>(),
  };

  const findWindow = (id: number) => world.windows.find((w) => w.id === id);
  const toWindow = (w: MockWindow): chrome.windows.Window =>
    ({
      id: w.id,
      focused: w.focused,
      incognito: w.incognito ?? false,
      alwaysOnTop: false,
      tabs: w.tabs.map((t) => ({ ...t, windowId: w.id, incognito: w.incognito ?? false })),
    }) as unknown as chrome.windows.Window;

  const events = {
    idleChanged: new MockEvent<(s: chrome.idle.IdleState) => void>(),
    tabActivated: new MockEvent<(info: { tabId: number; windowId: number }) => void>(),
    tabUpdated: new MockEvent<(id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void>(),
    tabRemoved: new MockEvent<(id: number, info: unknown) => void>(),
    focusChanged: new MockEvent<(windowId: number) => void>(),
    alarm: new MockEvent<(alarm: chrome.alarms.Alarm) => void>(),
    message: new MockEvent<
      (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => unknown
    >(),
    installed: new MockEvent<(d: unknown) => void>(),
    startup: new MockEvent<() => void>(),
  };

  const local = new MockStorageArea();
  const session = new MockStorageArea();

  const api = {
    storage: { local, session },
    alarms: {
      create: async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
        world.alarms.set(name, info);
      },
      get: async (name: string) => {
        const a = world.alarms.get(name);
        return a ? ({ name, scheduledTime: 0, periodInMinutes: a.periodInMinutes } as chrome.alarms.Alarm) : undefined;
      },
      clear: async (name: string) => world.alarms.delete(name),
      onAlarm: events.alarm,
    },
    idle: {
      setDetectionInterval: (s: number) => {
        world.detectionInterval = s;
      },
      queryState: async () => world.idleState as chrome.idle.IdleState,
      onStateChanged: events.idleChanged,
    },
    tabs: {
      onActivated: events.tabActivated,
      onUpdated: events.tabUpdated,
      onRemoved: events.tabRemoved,
      query: async () => world.windows.flatMap((w) => toWindow(w).tabs ?? []),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      get: async (id: number) => {
        const w = findWindow(id);
        if (!w) throw new Error(`No window with id: ${id}`);
        return toWindow(w);
      },
      getLastFocused: async () => {
        const w = world.windows.find((x) => x.focused) ?? world.windows[0];
        if (!w) throw new Error('No last-focused window');
        return toWindow(w);
      },
      onFocusChanged: events.focusChanged,
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => {
        world.badgeText = text;
      },
      setBadgeBackgroundColor: async ({ color }: { color: unknown }) => {
        world.badgeColor = color;
      },
      setBadgeTextColor: async () => undefined,
    },
    runtime: {
      id: 'test-extension-id',
      onMessage: events.message,
      onInstalled: events.installed,
      onStartup: events.startup,
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
      getManifest: () => ({ content_scripts: [{ js: ['content.js'], matches: ['<all_urls>'] }] }),
      sendMessage: async () => undefined,
    },
    scripting: {
      executeScript: async ({ target }: { target: { tabId: number } }) => {
        if (world.notScriptable.has(target.tabId)) throw new Error('Cannot access a chrome:// URL');
        world.injected.push(target.tabId);
        return [];
      },
    },
  };

  /** Convenience: one focused normal window with the given tabs. */
  function setWindows(windows: MockWindow[]): void {
    world.windows = windows;
  }

  function activeTab(): MockTab | undefined {
    return world.windows.find((w) => w.focused)?.tabs.find((t) => t.active);
  }

  function senderFor(tabId: number, url?: string): chrome.runtime.MessageSender {
    const w = world.windows.find((x) => x.tabs.some((t) => t.id === tabId));
    const tab = w?.tabs.find((t) => t.id === tabId);
    return {
      id: api.runtime.id,
      tab: { ...(tab ?? { id: tabId, url: url ?? '', active: false }), windowId: w?.id ?? 1 } as chrome.tabs.Tab,
      frameId: 0,
      url: url ?? tab?.url,
    };
  }

  return { api, world, events, local, session, setWindows, activeTab, senderFor };
}

export type ChromeMock = ReturnType<typeof createChromeMock>;

export function installChrome(): ChromeMock {
  const mock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = mock.api;
  return mock;
}
