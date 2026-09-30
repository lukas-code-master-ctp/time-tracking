/**
 * Web meeting rooms (spec 2026-09-30-en-reunion.md).
 *
 * A tab "has a meeting" when its URL is the room of a known platform. The URL
 * is only inspected here (host + path, and for Teams the `#/…` route of its
 * old web client); it is never stored because of this. A room only counts
 * while it plays audio or did so in the last 2 min, for every platform and
 * also with the tab in front (`isMeetingInProgress`, spec 2026-09-30-horarios):
 * a silent room left open (the "you left the meeting" page, a waiting room)
 * is not a meeting.
 *
 * Only the web clients in Chrome are detectable: desktop apps (Zoom, Teams…)
 * keep being measured with the system idle state.
 */

export type MeetingPlatform = 'meet' | 'zoom' | 'teams' | 'webex' | 'jitsi' | 'whereby' | 'goto';

/** Human names, for texts. */
export const MEETING_PLATFORM_NAMES: Readonly<Record<MeetingPlatform, string>> = Object.freeze({
  meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
  webex: 'Webex',
  jitsi: 'Jitsi Meet',
  whereby: 'Whereby',
  goto: 'GoTo Meeting',
});

/** A room without audio counts only this long after the tab last played sound. */
export const MEETING_AUDIO_GRACE_MS = 2 * 60_000;

const TEAMS_HOSTS = ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'];

/** Whereby pages that are not rooms (single path segment). */
const WHEREBY_NOT_ROOMS = new Set([
  'user',
  'login',
  'signup',
  'information',
  'pricing',
  'org',
  'dashboard',
  'blog',
  'about',
  'download',
  'embed',
  'legal',
  'support',
]);

/** Jitsi pages that are not rooms. */
const JITSI_NOT_ROOMS = new Set(['static', 'libs', 'images', 'sounds', 'css', 'lang', 'fonts']);

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function singleSegment(path: string): string | null {
  const m = /^\/([^/]+)\/?$/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * Platform whose meeting-room URL this is, or null. Accepts the raw tab URL
 * (query and hash are ignored except Teams' `#/meetup-join` route).
 */
export function meetingPlatformOf(url: string | null | undefined): MeetingPlatform | null {
  if (typeof url !== 'string' || url === '') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  if (host === 'meet.google.com') {
    if (/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(path)) return 'meet';
    if (/^\/lookup\/[^/]+/i.test(path)) return 'meet';
    return null;
  }
  if (hostIs(host, 'zoom.us')) {
    // Only the web client of a meeting (`/wc/<id>/join|start`, `/wc/join/<id>`).
    // `app.zoom.us/wc/home`, `/wc/team-chat`, `/wc/calendar`… are the Zoom
    // Workplace web app, and `/wc/leave` the page after leaving: not rooms.
    return /^\/wc\/(?:join\/)?\d{9,12}(?:\/|$)/i.test(path) ? 'zoom' : null;
  }
  if (TEAMS_HOSTS.includes(host)) {
    // New client on its own domain: every route (audio is always required).
    if (host === 'teams.cloud.microsoft') return 'teams';
    const route = path + u.hash;
    if (/^\/_#\/(l\/)?meetup-join(\/|$)/i.test(route)) return 'teams';
    if (/^\/l\/meetup-join\//i.test(path)) return 'teams';
    if (/^\/v2(\/|$)/i.test(path)) return 'teams';
    if (/^\/light-meetings\//i.test(path)) return 'teams';
    return null;
  }
  if (hostIs(host, 'webex.com')) {
    // `/webappng/sites/<site>/dashboard`, recordings, preferences… are the
    // site portal: only its `/meeting/` routes count.
    if (/^\/webappng\/sites\/[^/]+\/meeting\//i.test(path)) return 'webex';
    return /^\/(meet|wbxmjs)\/[^/]+/i.test(path) ? 'webex' : null;
  }
  if (host === 'meet.jit.si') {
    const room = singleSegment(path);
    return room && !JITSI_NOT_ROOMS.has(room.toLowerCase()) && !room.includes('.') ? 'jitsi' : null;
  }
  if (host === 'whereby.com') {
    const room = singleSegment(path);
    return room && !WHEREBY_NOT_ROOMS.has(room.toLowerCase()) && !room.includes('.') ? 'whereby' : null;
  }
  if (host === 'app.goto.com') {
    return /^\/meeting\/[^/]+/i.test(path) ? 'goto' : null;
  }
  if (host === 'meet.goto.com') {
    return /^\/[^/]+/.test(path) ? 'goto' : null;
  }
  return null;
}

/** True when `url` is a meeting room of a known platform. */
export function isMeetingUrl(url: string | null | undefined): boolean {
  return meetingPlatformOf(url) !== null;
}

export interface MeetingTabInput {
  url: string | null | undefined;
  /** `tab.audible` right now. */
  audible: boolean;
  /** Last instant the tab was seen audible (ms), or null. */
  lastAudibleAt: number | null;
}

/**
 * Whether this tab holds a meeting in progress at `now`: a meeting room that
 * is playing audio or played it at most 2 min ago. Being in front is not
 * enough (spec 2026-09-30-horarios). Pure.
 */
export function isMeetingInProgress(tab: MeetingTabInput, now: number): boolean {
  if (!isMeetingUrl(tab.url)) return false;
  return tab.audible || (tab.lastAudibleAt !== null && now - tab.lastAudibleAt <= MEETING_AUDIO_GRACE_MS);
}
