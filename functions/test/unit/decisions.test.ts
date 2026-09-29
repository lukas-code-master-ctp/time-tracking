import { describe, expect, it } from 'vitest';
import { DEFAULT_SCREENSHOT_RETENTION_DAYS, MAX_SESSION_MS, STALE_SESSION_MS } from '@timetracking/shared';
import { decideAutoClose } from '../../src/core/autoClose.js';
import { retentionDaysOf } from '../../src/core/purge.js';

const NOW = 1_790_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('decideAutoClose', () => {
  it('keeps a recent open session', () => {
    expect(decideAutoClose({ startedAt: NOW - 2 * HOUR, lastHeartbeatAt: NOW - MIN }, NOW).close).toBe(false);
  });

  it('keeps a session whose heartbeat is exactly at the threshold', () => {
    expect(
      decideAutoClose({ startedAt: NOW - HOUR, lastHeartbeatAt: NOW - STALE_SESSION_MS }, NOW).close,
    ).toBe(false);
  });

  it('closes a session without heartbeat for more than 30 min, at its last heartbeat', () => {
    const hb = NOW - STALE_SESSION_MS - 1;
    expect(decideAutoClose({ startedAt: NOW - 3 * HOUR, lastHeartbeatAt: hb }, NOW)).toEqual({
      close: true,
      endedAt: hb,
    });
  });

  it('closes a session open for more than 16 h even with a fresh heartbeat, capped at start + 16 h', () => {
    const startedAt = NOW - MAX_SESSION_MS - HOUR;
    expect(decideAutoClose({ startedAt, lastHeartbeatAt: NOW - MIN }, NOW)).toEqual({
      close: true,
      endedAt: startedAt + MAX_SESSION_MS,
    });
  });

  it('never ends before it started and tolerates a missing heartbeat', () => {
    const startedAt = NOW - 2 * HOUR;
    expect(decideAutoClose({ startedAt, lastHeartbeatAt: startedAt - 5 * MIN }, NOW).endedAt).toBe(startedAt);
    expect(decideAutoClose({ startedAt, lastHeartbeatAt: undefined as unknown as number }, NOW)).toEqual({
      close: true,
      endedAt: startedAt,
    });
  });
});

describe('retentionDaysOf', () => {
  it('uses valid integer values and falls back to the default', () => {
    expect(retentionDaysOf(30)).toBe(30);
    expect(retentionDaysOf(undefined)).toBe(DEFAULT_SCREENSHOT_RETENTION_DAYS);
    expect(retentionDaysOf(0)).toBe(DEFAULT_SCREENSHOT_RETENTION_DAYS);
    expect(retentionDaysOf(1.5)).toBe(DEFAULT_SCREENSHOT_RETENTION_DAYS);
    expect(retentionDaysOf('30')).toBe(DEFAULT_SCREENSHOT_RETENTION_DAYS);
  });
});
