import { describe, expect, it } from 'vitest';
import {
  MEETING_AUDIO_GRACE_MS,
  isMeetingInProgress,
  isMeetingUrl,
  meetingNeedsAudio,
  meetingPlatformOf,
  type MeetingPlatform,
} from '../src/meetings.js';

const positives: [MeetingPlatform, string][] = [
  ['meet', 'https://meet.google.com/abc-defg-hij'],
  ['meet', 'https://meet.google.com/abc-defg-hij?authuser=1&pli=1'],
  ['meet', 'https://meet.google.com/ABC-DEFG-HIJ/'],
  ['meet', 'https://meet.google.com/lookup/abcdefgh'],
  ['zoom', 'https://app.zoom.us/wc/123456789/join?fromPWA=1'],
  ['zoom', 'https://us05web.zoom.us/wc/join/123456789'],
  ['zoom', 'https://zoom.us/wc/987654321/start'],
  ['teams', 'https://teams.microsoft.com/_#/meetup-join/19:meeting_abc@thread.v2/0'],
  ['teams', 'https://teams.microsoft.com/_#/l/meetup-join/19:meeting_abc'],
  ['teams', 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x'],
  ['teams', 'https://teams.microsoft.com/v2/'],
  ['teams', 'https://teams.live.com/light-meetings/launch?p=abc'],
  ['teams', 'https://teams.cloud.microsoft/v2/'],
  ['webex', 'https://acme.webex.com/meet/juan.perez'],
  ['webex', 'https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/download/abc'],
  ['webex', 'https://web.webex.com/webappng/sites/acme/meeting/info/abc'],
  ['jitsi', 'https://meet.jit.si/ReunionSemanal'],
  ['jitsi', 'https://meet.jit.si/ReunionSemanal#config.startWithAudioMuted=true'],
  ['whereby', 'https://whereby.com/equipo-ventas'],
  ['goto', 'https://app.goto.com/meeting/123456789'],
  ['goto', 'https://meet.goto.com/123456789'],
];

const negatives: string[] = [
  // Meet: home page, landing, other paths, look-alike hosts.
  'https://meet.google.com/',
  'https://meet.google.com/landing',
  'https://meet.google.com/new',
  'https://meet.google.com/abc-defg',
  'https://meet.google.com/abc-defg-hij/extra',
  'https://meet.google.com.evil.com/abc-defg-hij',
  'https://calendar.google.com/calendar/u/0/r',
  // Zoom: launcher page, account pages.
  'https://zoom.us/',
  'https://us05web.zoom.us/j/123456789?pwd=x',
  'https://zoom.us/signin',
  'https://notzoom.us/wc/123/join',
  // Teams: chat, calendar, home.
  'https://teams.microsoft.com/_#/conversations/General?threadId=19:x',
  'https://teams.microsoft.com/_#/calendarv2',
  'https://teams.microsoft.com/',
  'https://teams.live.com/',
  'https://teams.microsoft.com.evil.com/v2/',
  // Webex: portal.
  'https://acme.webex.com/',
  'https://acme.webex.com/webappng',
  'https://www.webex.com/pricing',
  // Jitsi / Whereby: home and non-room pages.
  'https://meet.jit.si/',
  'https://meet.jit.si/static/close.html',
  'https://whereby.com/',
  'https://whereby.com/user',
  'https://whereby.com/information/tos',
  'https://whereby.com/favicon.ico',
  // GoTo
  'https://app.goto.com/',
  'https://app.goto.com/meeting',
  'https://meet.goto.com/',
  // Not web pages / invalid
  'chrome://newtab/',
  'file:///C:/meet.google.com/abc-defg-hij',
  'not a url',
  '',
];

describe('meetingPlatformOf', () => {
  it.each(positives)('%s: %s', (platform, url) => {
    expect(meetingPlatformOf(url)).toBe(platform);
    expect(isMeetingUrl(url)).toBe(true);
  });

  it.each(negatives)('not a meeting room: %s', (url) => {
    expect(meetingPlatformOf(url)).toBeNull();
    expect(isMeetingUrl(url)).toBe(false);
  });

  it('handles null / undefined', () => {
    expect(meetingPlatformOf(null)).toBeNull();
    expect(isMeetingUrl(undefined)).toBe(false);
  });

  it('only Teams always needs audio', () => {
    expect(meetingNeedsAudio('teams')).toBe(true);
    for (const p of ['meet', 'zoom', 'webex', 'jitsi', 'whereby', 'goto'] as const) expect(meetingNeedsAudio(p)).toBe(false);
  });
});

describe('isMeetingInProgress', () => {
  const NOW = 1_790_000_000_000;
  const MEET = 'https://meet.google.com/abc-defg-hij';
  const TEAMS = 'https://teams.microsoft.com/v2/';

  it('a room in front counts even without audio', () => {
    expect(isMeetingInProgress({ url: MEET, inFront: true, audible: false, lastAudibleAt: null }, NOW)).toBe(true);
  });

  it('a room in the background counts while audible or up to 2 min after', () => {
    expect(isMeetingInProgress({ url: MEET, inFront: false, audible: true, lastAudibleAt: null }, NOW)).toBe(true);
    expect(isMeetingInProgress({ url: MEET, inFront: false, audible: false, lastAudibleAt: NOW - MEETING_AUDIO_GRACE_MS }, NOW)).toBe(true);
    expect(isMeetingInProgress({ url: MEET, inFront: false, audible: false, lastAudibleAt: NOW - MEETING_AUDIO_GRACE_MS - 1 }, NOW)).toBe(false);
    expect(isMeetingInProgress({ url: MEET, inFront: false, audible: false, lastAudibleAt: null }, NOW)).toBe(false);
  });

  it('Teams needs recent audio even in front', () => {
    expect(isMeetingInProgress({ url: TEAMS, inFront: true, audible: false, lastAudibleAt: null }, NOW)).toBe(false);
    expect(isMeetingInProgress({ url: TEAMS, inFront: true, audible: true, lastAudibleAt: null }, NOW)).toBe(true);
    expect(isMeetingInProgress({ url: TEAMS, inFront: false, audible: false, lastAudibleAt: NOW - 60_000 }, NOW)).toBe(true);
  });

  it('audio on a page that is not a meeting room does not count', () => {
    expect(isMeetingInProgress({ url: 'https://www.youtube.com/watch', inFront: true, audible: true, lastAudibleAt: NOW }, NOW)).toBe(false);
  });
});
