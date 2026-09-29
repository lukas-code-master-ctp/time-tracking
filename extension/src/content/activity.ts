/**
 * Content script (classic script, bundled as IIFE): reports THAT the user is
 * using keyboard/mouse on this page, at most once per second. It never reads
 * which key, where, nor any page content: the only payload is a timestamp.
 *
 * Sends `{ type: 'hello' }` once when loaded (the tab becomes "measurable")
 * and `{ type: 'activity', t }` on input.
 *
 * Robust to being injected twice (manifest + executeScript after an update)
 * and to the extension being reloaded/updated: the old copy loses its
 * context ("Extension context invalidated") and detaches silently.
 */
import type { ContentMessage } from '../messages';

const EVENTS = ['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart', 'scroll'] as const;
const OWNER_KEY = '__timetrackingActivityOwner';

type OwnerWindow = Window & { [OWNER_KEY]?: string };

(() => {
  const w = window as OwnerWindow;
  // The newest copy wins; older copies detach on their next event.
  const instance = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  w[OWNER_KEY] = instance;

  let lastSecond = -1;
  let detached = false;
  const options: AddEventListenerOptions = { capture: true, passive: true };

  function contextAlive(): boolean {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function detach(): void {
    if (detached) return;
    detached = true;
    for (const type of EVENTS) window.removeEventListener(type, onInput, options);
  }

  function send(msg: ContentMessage): void {
    if (!contextAlive()) {
      detach();
      return;
    }
    try {
      const p = chrome.runtime.sendMessage(msg) as Promise<unknown> | undefined;
      // No listener / worker restarting / context invalidated: ignore.
      p?.catch?.(() => {
        if (!contextAlive()) detach();
      });
    } catch {
      detach();
    }
  }

  function onInput(event: Event): void {
    if (w[OWNER_KEY] !== instance) {
      detach();
      return;
    }
    if (!event.isTrusted || document.visibilityState !== 'visible') return;
    const now = Date.now();
    const second = Math.floor(now / 1000);
    if (second === lastSecond) return; // throttle: 1 message per second
    lastSecond = second;
    send({ type: 'activity', t: now });
  }

  for (const type of EVENTS) window.addEventListener(type, onInput, options);
  send({ type: 'hello' });
})();
