/**
 * Videos of the company in the active breaks (spec 2026-11-13-videos-pausa-activa):
 * the admin pins up to 10 links (YouTube, Vimeo, Drive, an intranet…) in
 * `config/breakVideos`, and the extension shows them in the breaks,
 * interleaved with the exercises of the library or instead of them (`mode`).
 * A document of its own: validating 10 videos inside `config/org` goes over
 * the 1000 expressions a rules request may evaluate. The video opens in a new tab (YouTube does not
 * play embedded in extension pages).
 *
 * A video break is stored in `breaks/{id}.exercise` as `video:<video id>`.
 */
import type { ActiveBreakExercise } from './exercises.js';

export interface BreakVideo {
  /** Random, stable (keeps the rotation and the `breaks` docs pointing at the same video). */
  id: string;
  title: string;
  /** https only. */
  url: string;
}

/** `alternate`: one break a video, the next an exercise; `always`: only videos. */
export type BreakVideoMode = 'alternate' | 'always';

/** `config/breakVideos`. */
export interface BreakVideosConfig {
  /** 0–10, in the admin's order. */
  videos: BreakVideo[];
  mode: BreakVideoMode;
  updatedAt: number;
  updatedBy: string;
}

export const MAX_BREAK_VIDEOS = 10;
export const MAX_BREAK_VIDEO_TITLE = 80;
export const MAX_BREAK_VIDEO_URL = 500;
export const DEFAULT_BREAK_VIDEO_MODE: BreakVideoMode = 'alternate';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const VIDEO_PREFIX = 'video:';

/**
 * The link as stored: trimmed, `https://` added when there is no scheme;
 * null when it is not a valid https URL (http, javascript:, spaces…).
 */
export function normalizeVideoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '' || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return null;
  const href = u.href;
  return href.length <= MAX_BREAK_VIDEO_URL ? href : null;
}

/** Title as stored (trimmed, spaces collapsed); null when empty or too long. */
export function normalizeVideoTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length >= 1 && t.length <= MAX_BREAK_VIDEO_TITLE ? t : null;
}

/** A valid video, or null. */
export function readBreakVideo(raw: unknown): BreakVideo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { id?: unknown; title?: unknown; url?: unknown };
  const title = normalizeVideoTitle(r.title);
  const url = normalizeVideoUrl(r.url);
  // Stored URLs are already normalized: one that changes is not accepted (the rules check the raw value).
  if (typeof r.id !== 'string' || !VIDEO_ID_RE.test(r.id) || !title || !url || url !== r.url) return null;
  return { id: r.id, title, url };
}

/** The valid videos of a `config/breakVideos` document (in the admin's order, unique ids, at most 10). */
export function readBreakVideos(doc: unknown): BreakVideo[] {
  const list = (doc && typeof doc === 'object' ? (doc as { videos?: unknown }).videos : null) ?? [];
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: BreakVideo[] = [];
  for (const raw of list) {
    const v = readBreakVideo(raw);
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
    if (out.length >= MAX_BREAK_VIDEOS) break;
  }
  return out;
}

export function readBreakVideoMode(doc: unknown): BreakVideoMode {
  const m = doc && typeof doc === 'object' ? (doc as { mode?: unknown }).mode : null;
  return m === 'always' ? 'always' : DEFAULT_BREAK_VIDEO_MODE;
}

/** A new random id for a video (10 characters). */
export function newBreakVideoId(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

/** The YouTube video id of a link (watch, youtu.be, shorts, embed, live), or null. */
export function youtubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(u.pathname);
      id = m ? m[1]! : null;
    }
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

/** A thumbnail of the video (only YouTube has a public one), or null. */
export function videoThumbnail(url: string): string | null {
  const id = youtubeVideoId(url);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}

/** "youtube.com", "vimeo.com", "drive.google.com". */
export function videoSite(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** What `breaks/{id}.exercise` holds for a video break. */
export function videoBreakId(video: Pick<BreakVideo, 'id'>): string {
  return `${VIDEO_PREFIX}${video.id}`;
}

/** The video id of a `breaks/{id}.exercise`, or null when it is an exercise. */
export function parseVideoBreakId(exercise: string): string | null {
  return exercise.startsWith(VIDEO_PREFIX) && VIDEO_ID_RE.test(exercise.slice(VIDEO_PREFIX.length))
    ? exercise.slice(VIDEO_PREFIX.length)
    : null;
}

/** What a break suggests: an exercise of the library or a video of the company. */
export type BreakItem = { kind: 'exercise'; exercise: ActiveBreakExercise } | { kind: 'video'; video: BreakVideo };

/** The id stored in `breaks/{id}.exercise` for `item`. */
export function breakItemId(item: BreakItem): string {
  return item.kind === 'video' ? videoBreakId(item.video) : item.exercise.id;
}

/**
 * The `n`-th break with `videos`: without videos, `exerciseAt(n)`. `always`:
 * the videos in turn. `alternate`: odd breaks a video (in turn), even ones
 * the exercise rotation at half speed, so it still goes through all of them.
 */
export function videoRotation(
  n: number,
  videos: readonly BreakVideo[],
  mode: BreakVideoMode,
  exerciseAt: (n: number) => ActiveBreakExercise,
): BreakItem {
  const i = Math.max(0, Math.floor(n));
  if (videos.length === 0) return { kind: 'exercise', exercise: exerciseAt(i) };
  if (mode === 'always') return { kind: 'video', video: videos[i % videos.length]! };
  const half = Math.floor(i / 2);
  return i % 2 === 1 ? { kind: 'video', video: videos[half % videos.length]! } : { kind: 'exercise', exercise: exerciseAt(half) };
}
