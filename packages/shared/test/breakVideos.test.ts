import { describe, expect, it } from 'vitest';
import {
  ACTIVE_BREAK_EXERCISES,
  breakItemAt,
  breakItemById,
  breakItemId,
  dailyBreakItem,
  dailyExercise,
  exerciseAt,
  normalizeVideoUrl,
  parseVideoBreakId,
  readActiveBreakSettings,
  readBreakVideos,
  videoThumbnail,
  youtubeVideoId,
  newBreakVideoId,
} from '../src/index.js';

const A = { id: 'aaa111', title: 'Hombros', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
const B = { id: 'bbb222', title: 'Espalda', url: 'https://vimeo.com/123456' };

describe('active break videos', () => {
  it('accepts https links only, adding the scheme when missing', () => {
    expect(normalizeVideoUrl(' youtu.be/dQw4w9WgXcQ ')).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(normalizeVideoUrl('https://vimeo.com/1')).toBe('https://vimeo.com/1');
    for (const bad of ['http://vimeo.com/1', 'javascript:alert(1)', 'https://a b.cl', '', 'localhost', 'https://u:p@x.cl/v', 7]) {
      expect(normalizeVideoUrl(bad)).toBeNull();
    }
    expect(normalizeVideoUrl(`https://x.cl/${'a'.repeat(600)}`)).toBeNull();
  });

  it('reads the valid videos of config/breakVideos, unique, at most 10', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `v${i}`, title: `Video ${i}`, url: `https://x.cl/${i}` }));
    expect(readBreakVideos({ videos: many })).toHaveLength(10);
    expect(
      readBreakVideos({
        videos: [A, A, { ...B, url: 'http://vimeo.com/1' }, { ...B, id: 'bad id' }, { ...B, title: ' ' }, B, null],
      }),
    ).toEqual([A, B]);
    expect(readBreakVideos({ videos: 'x' })).toEqual([]);
    expect(readBreakVideos(null)).toEqual([]);
    expect(readActiveBreakSettings({ activeBreaksEnabled: true }, { videos: [A], mode: 'always' })).toMatchObject({
      videos: [A],
      videoMode: 'always',
    });
    expect(readActiveBreakSettings({}, { mode: 'never' }).videoMode).toBe('alternate');
  });

  it('YouTube ids and thumbnails', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://m.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://vimeo.com/123')).toBeNull();
    expect(videoThumbnail(A.url)).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
    expect(videoThumbnail(B.url)).toBeNull();
    expect(newBreakVideoId()).toMatch(/^[a-z0-9]{10}$/);
  });

  it('without videos the rotation is the exercises, as before', () => {
    for (let n = 0; n < 60; n++) expect(breakItemAt(n, { videos: [] })).toEqual({ kind: 'exercise', exercise: exerciseAt(n) });
    const s = { mode: 'daily' as const, perDay: 3, times: [] };
    expect(dailyBreakItem(s, '2026-11-13', 1)).toEqual({ kind: 'exercise', exercise: dailyExercise('2026-11-13', 1, 3) });
  });

  it('alternate: a video every other break, in turn; the exercises still go through the whole library', () => {
    const s = { videos: [A, B], videoMode: 'alternate' as const };
    const items = Array.from({ length: ACTIVE_BREAK_EXERCISES.length * 2 }, (_, n) => breakItemAt(n, s));
    expect(items.slice(0, 6).map((i) => i.kind)).toEqual(['exercise', 'video', 'exercise', 'video', 'exercise', 'video']);
    expect(items.filter((i) => i.kind === 'video').slice(0, 3).map((i) => (i.kind === 'video' ? i.video.id : ''))).toEqual([A.id, B.id, A.id]);
    const ids = new Set(items.flatMap((i) => (i.kind === 'exercise' ? [i.exercise.id] : [])));
    expect(ids.size).toBe(ACTIVE_BREAK_EXERCISES.length);
  });

  it('always: only videos', () => {
    const s = { videos: [A, B], videoMode: 'always' as const };
    expect([0, 1, 2].map((n) => breakItemAt(n, s))).toEqual([
      { kind: 'video', video: A },
      { kind: 'video', video: B },
      { kind: 'video', video: A },
    ]);
  });

  it('video breaks are stored as video:<id> and looked up again', () => {
    const item = { kind: 'video' as const, video: A };
    expect(breakItemId(item)).toBe('video:aaa111');
    expect(parseVideoBreakId('video:aaa111')).toBe('aaa111');
    expect(parseVideoBreakId('cuello-lados')).toBeNull();
    expect(breakItemById('video:aaa111', [A, B])).toEqual(item);
    // Removed since: unknown.
    expect(breakItemById('video:aaa111', [B])).toBeNull();
    expect(breakItemById(ACTIVE_BREAK_EXERCISES[0]!.id)).toEqual({ kind: 'exercise', exercise: ACTIVE_BREAK_EXERCISES[0] });
  });
});
