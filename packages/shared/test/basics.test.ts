import { describe, expect, it } from 'vitest';
import { SLOT_MS, slotEndOf, slotStartOf, slotsBetween } from '../src/slots.js';
import { domainOf, sanitizeUrl } from '../src/url.js';
import {
  activityDocId,
  COLLECTIONS,
  dateKey,
  emailKey,
  parseActivityDocId,
  screenshotStoragePath,
} from '../src/collections.js';
import { emailDomain, isAllowedEmail, normalizeDomain, parseEmailList } from '../src/domain.js';
import { DEFAULT_ALLOWED_DOMAIN, defaultOrgConfig, resolveConfig } from '../src/config.js';
import * as shared from '../src/index.js';

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);

describe('slots', () => {
  it('SLOT_MS is 10 minutes', () => {
    expect(SLOT_MS).toBe(600_000);
  });

  it('slotStartOf aligns to the clock', () => {
    expect(slotStartOf(T0)).toBe(T0);
    expect(slotStartOf(T0 + 1)).toBe(T0);
    expect(slotStartOf(T0 + SLOT_MS - 1)).toBe(T0);
    expect(slotStartOf(T0 + SLOT_MS)).toBe(T0 + SLOT_MS);
    expect(slotStartOf(Date.UTC(2026, 8, 29, 12, 17, 45, 123))).toBe(Date.UTC(2026, 8, 29, 12, 10));
    expect(slotEndOf(T0 + 5)).toBe(T0 + SLOT_MS);
  });

  it('matches 10-minute wall clock marks in Chile', () => {
    const start = slotStartOf(Date.UTC(2026, 8, 29, 12, 34, 56));
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Santiago',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(start));
    expect(local).toBe('30:00');
  });

  it('slotsBetween returns every intersecting block of [from, to)', () => {
    expect(slotsBetween(T0, T0)).toEqual([]);
    expect(slotsBetween(T0 + 10, T0)).toEqual([]);
    expect(slotsBetween(T0, T0 + 1)).toEqual([T0]);
    expect(slotsBetween(T0, T0 + SLOT_MS)).toEqual([T0]);
    expect(slotsBetween(T0 + 5, T0 + SLOT_MS + 1)).toEqual([T0, T0 + SLOT_MS]);
    expect(slotsBetween(T0 - 1, T0 + 2 * SLOT_MS)).toEqual([T0 - SLOT_MS, T0, T0 + SLOT_MS]);
    expect(slotsBetween(T0, T0 + 24 * 3600_000)).toHaveLength(144);
  });
});

describe('url', () => {
  it('removes query, hash and credentials', () => {
    expect(sanitizeUrl('https://user:pw@Docs.Google.com/d/1?x=1#h')).toBe('https://docs.google.com/d/1');
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com/');
    expect(sanitizeUrl('https://example.com:8443/a/b/?q')).toBe('https://example.com:8443/a/b/');
    expect(sanitizeUrl('https://example.com/a#frag?notquery')).toBe('https://example.com/a');
  });

  it('returns null for non http/https or invalid URLs', () => {
    for (const bad of [
      'chrome://extensions',
      'chrome-extension://abc/popup.html',
      'file:///C:/x.pdf',
      'about:blank',
      'data:text/html,hi',
      'javascript:alert(1)',
      'ftp://example.com/',
      'not a url',
      '',
    ]) {
      expect(sanitizeUrl(bad)).toBeNull();
      expect(domainOf(bad)).toBeNull();
    }
  });

  it('domainOf lowercases, strips www. and port', () => {
    expect(domainOf('https://WWW.Example.COM:8080/x?y')).toBe('example.com');
    expect(domainOf('https://mail.google.com/mail')).toBe('mail.google.com');
    expect(domainOf('http://localhost:5173/')).toBe('localhost');
    expect(domainOf('http://192.168.1.10/')).toBe('192.168.1.10');
    expect(domainOf('https://www2.example.com/')).toBe('www2.example.com');
  });
});

describe('collections', () => {
  it('exposes collection names', () => {
    expect(COLLECTIONS).toEqual({
      config: 'config',
      invitations: 'invitations',
      users: 'users',
      sessions: 'sessions',
      activity: 'activity',
      screenshots: 'screenshots',
    });
  });

  it('emailKey trims and lowercases', () => {
    expect(emailKey('  Ana.Perez@CompraTuParcela.CL ')).toBe('ana.perez@compratuparcela.cl');
  });

  it('activityDocId is deterministic and reversible', () => {
    expect(activityDocId('abc', T0)).toBe(`abc_${T0}`);
    expect(parseActivityDocId(`abc_${T0}`)).toEqual({ uid: 'abc', slotStart: T0 });
    expect(parseActivityDocId(`a_b_${T0}`)).toEqual({ uid: 'a_b', slotStart: T0 });
    expect(parseActivityDocId('abc')).toBeNull();
    expect(parseActivityDocId('abc_')).toBeNull();
    expect(parseActivityDocId('_123')).toBeNull();
    expect(parseActivityDocId('abc_12x')).toBeNull();
    expect(() => activityDocId('', T0)).toThrow();
    expect(() => activityDocId('abc', 1.5)).toThrow();
    expect(() => activityDocId('abc', -1)).toThrow();
  });

  it('dateKey uses the Chile time zone by default', () => {
    // 02:00 UTC on Sep 30 is still Sep 29 in Santiago (UTC-3).
    expect(dateKey(Date.UTC(2026, 8, 30, 2, 0))).toBe('2026-09-29');
    expect(dateKey(Date.UTC(2026, 8, 30, 2, 0), 'UTC')).toBe('2026-09-30');
  });

  it('screenshotStoragePath follows screenshots/{uid}/{date}/{id}.jpg', () => {
    expect(screenshotStoragePath('u1', T0, 'shot1')).toBe('screenshots/u1/2026-09-29/shot1.jpg');
    expect(() => screenshotStoragePath('u/1', T0, 'x')).toThrow();
    expect(() => screenshotStoragePath('u1', T0, '')).toThrow();
  });
});

describe('domain', () => {
  it('accepts only the exact allowed domain, case-insensitive', () => {
    expect(isAllowedEmail('ana@compratuparcela.cl', 'compratuparcela.cl')).toBe(true);
    expect(isAllowedEmail(' Ana@CompraTuParcela.cl ', '@CompraTuParcela.CL')).toBe(true);
    expect(isAllowedEmail('ana@x.compratuparcela.cl', 'compratuparcela.cl')).toBe(false);
    expect(isAllowedEmail('ana@evilcompratuparcela.cl', 'compratuparcela.cl')).toBe(false);
    expect(isAllowedEmail('ana@compratuparcela.cl.evil.com', 'compratuparcela.cl')).toBe(false);
    expect(isAllowedEmail('ana@gmail.com', 'compratuparcela.cl')).toBe(false);
    expect(isAllowedEmail('compratuparcela.cl', 'compratuparcela.cl')).toBe(false);
    expect(isAllowedEmail('a@b@compratuparcela.cl', 'compratuparcela.cl')).toBe(false);
    expect(isAllowedEmail('ana@compratuparcela.cl', '')).toBe(false);
    expect(isAllowedEmail('', 'compratuparcela.cl')).toBe(false);
  });

  it('emailDomain / normalizeDomain', () => {
    expect(emailDomain('X@Foo.CL')).toBe('foo.cl');
    expect(emailDomain('nope')).toBeNull();
    expect(normalizeDomain(' @Foo.CL ')).toBe('foo.cl');
  });

  it('parseEmailList splits, normalizes and dedupes', () => {
    expect(parseEmailList(' A@x.cl, b@x.cl;a@X.cl  c@x.cl\nnot-an-email ')).toEqual(['a@x.cl', 'b@x.cl', 'c@x.cl']);
    expect(parseEmailList(undefined)).toEqual([]);
    expect(parseEmailList('')).toEqual([]);
  });
});

describe('config', () => {
  it('has safe defaults', () => {
    expect(resolveConfig()).toEqual({ allowedDomain: DEFAULT_ALLOWED_DOMAIN, bootstrapAdmins: [], appEnv: 'prod' });
    expect(DEFAULT_ALLOWED_DOMAIN).toBe('compratuparcela.cl');
  });

  it('reads plain and VITE_ prefixed variables', () => {
    expect(
      resolveConfig({ ALLOWED_DOMAIN: 'Foo.cl', BOOTSTRAP_ADMINS: 'Boss@foo.cl, ops@foo.cl', APP_ENV: 'dev' }),
    ).toEqual({ allowedDomain: 'foo.cl', bootstrapAdmins: ['boss@foo.cl', 'ops@foo.cl'], appEnv: 'dev' });
    expect(resolveConfig({ VITE_APP_ENV: 'DEV', VITE_ALLOWED_DOMAIN: 'bar.cl', DEV: true })).toMatchObject({
      allowedDomain: 'bar.cl',
      appEnv: 'dev',
    });
    expect(resolveConfig({ APP_ENV: 'staging' }).appEnv).toBe('prod');
    expect(resolveConfig({ ALLOWED_DOMAIN: '   ' }).allowedDomain).toBe(DEFAULT_ALLOWED_DOMAIN);
  });

  it('defaultOrgConfig', () => {
    expect(defaultOrgConfig(T0)).toEqual({
      allowedDomain: 'compratuparcela.cl',
      screenshotsEnabled: false,
      blurScreenshots: true,
      screenshotRetentionDays: 90,
      updatedAt: T0,
      updatedBy: 'system',
    });
  });
});

describe('index', () => {
  it('re-exports the public API', () => {
    for (const name of [
      'SlotAccumulator',
      'slotStartOf',
      'slotsBetween',
      'sanitizeUrl',
      'domainOf',
      'activityDocId',
      'emailKey',
      'isAllowedEmail',
      'summarizeMember',
      'summarizeTeam',
      'toCsv',
      'resolveConfig',
      'COLLECTIONS',
      'SLOT_MS',
    ]) {
      expect(shared).toHaveProperty(name);
    }
  });
});
