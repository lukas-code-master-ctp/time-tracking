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
import {
  MAX_ALLOWED_DOMAINS,
  emailDomain,
  formatDomains,
  isAllowedEmail,
  isValidDomain,
  normalizeDomain,
  normalizeDomainList,
  parseDomainList,
  parseEmailList,
} from '../src/domain.js';
import {
  DEFAULT_ALLOWED_DOMAINS,
  allowedDomainsOr,
  defaultOrgConfig,
  readAllowedDomains,
  resolveConfig,
} from '../src/config.js';
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

  it('accepts any domain of a list, exactly (no subdomains or look-alikes)', () => {
    const list = ['impulseai.cl', 'compratuparcela.cl'];
    expect(isAllowedEmail('lukas@impulseai.cl', list)).toBe(true);
    expect(isAllowedEmail('Ana@CompraTuParcela.CL', list)).toBe(true);
    expect(isAllowedEmail('ana@IMPULSEAI.cl', [' @ImpulseAI.cl '])).toBe(true);
    for (const bad of [
      'a@sub.impulseai.cl',
      'a@x.compratuparcela.cl',
      'a@evilimpulseai.cl',
      'a@impulseai.cl.evil.com',
      'a@impulseai.com',
      'z@gmail.com',
      'impulseai.cl',
      'a@b@impulseai.cl',
    ]) {
      expect(isAllowedEmail(bad, list), bad).toBe(false);
    }
    expect(isAllowedEmail('a@impulseai.cl', [])).toBe(false);
    expect(isAllowedEmail('a@impulseai.cl', ['', '  '])).toBe(false);
    expect(isAllowedEmail('a@impulseai.cl', [42 as unknown as string, 'impulseai.cl'])).toBe(true);
    expect(isAllowedEmail('a@impulseai.cl', null as unknown as string[])).toBe(false);
  });

  it('parseDomainList / normalizeDomainList normalize, drop empties and dedupe', () => {
    expect(parseDomainList(' ImpulseAI.cl, @compratuparcela.cl ;impulseai.cl  otra.cl\n')).toEqual([
      'impulseai.cl',
      'compratuparcela.cl',
      'otra.cl',
    ]);
    expect(parseDomainList('compratuparcela.cl')).toEqual(['compratuparcela.cl']);
    expect(parseDomainList(',, ,')).toEqual([]);
    expect(parseDomainList('')).toEqual([]);
    expect(parseDomainList(undefined)).toEqual([]);
    expect(parseDomainList(null)).toEqual([]);
    expect(normalizeDomainList(['A.cl', '@a.cl', '', 3, null, 'b.cl'])).toEqual(['a.cl', 'b.cl']);
  });

  it('isValidDomain', () => {
    expect(isValidDomain('impulseai.cl')).toBe(true);
    expect(isValidDomain('mail.empresa.com')).toBe(true);
    for (const bad of ['', 'cl', 'no dominio.cl', 'a..cl', '-a.cl', 'a@b.cl', 'IMPULSEAI.CL']) {
      expect(isValidDomain(bad), bad).toBe(false);
    }
  });

  it('formatDomains builds the Spanish list', () => {
    expect(formatDomains(['impulseai.cl', 'compratuparcela.cl'])).toBe('@impulseai.cl o @compratuparcela.cl');
    expect(formatDomains(['a.cl'])).toBe('@a.cl');
    expect(formatDomains(['a.cl', 'B.cl', 'c.cl'])).toBe('@a.cl, @b.cl o @c.cl');
    expect(formatDomains([])).toBe('');
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
    expect(resolveConfig()).toEqual({
      allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
      bootstrapAdmins: [],
      appEnv: 'prod',
    });
    expect(DEFAULT_ALLOWED_DOMAINS).toEqual(['impulseai.cl', 'compratuparcela.cl']);
    expect(Object.isFrozen(DEFAULT_ALLOWED_DOMAINS)).toBe(true);
    expect(MAX_ALLOWED_DOMAINS).toBe(10);
  });

  it('reads plain and VITE_ prefixed variables', () => {
    expect(
      resolveConfig({ ALLOWED_DOMAIN: 'Foo.cl', BOOTSTRAP_ADMINS: 'Boss@foo.cl, ops@foo.cl', APP_ENV: 'dev' }),
    ).toEqual({ allowedDomains: ['foo.cl'], bootstrapAdmins: ['boss@foo.cl', 'ops@foo.cl'], appEnv: 'dev' });
    expect(resolveConfig({ VITE_APP_ENV: 'DEV', VITE_ALLOWED_DOMAIN: 'bar.cl', DEV: true })).toMatchObject({
      allowedDomains: ['bar.cl'],
      appEnv: 'dev',
    });
    expect(resolveConfig({ APP_ENV: 'staging' }).appEnv).toBe('prod');
    expect(resolveConfig({ ALLOWED_DOMAIN: '   ' }).allowedDomains).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
    expect(resolveConfig({ ALLOWED_DOMAIN: ' , ; ' }).allowedDomains).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
  });

  it('reads ALLOWED_DOMAIN as a comma separated list (max 10)', () => {
    expect(resolveConfig({ ALLOWED_DOMAIN: 'impulseai.cl,CompraTuParcela.cl, impulseai.cl' }).allowedDomains).toEqual([
      'impulseai.cl',
      'compratuparcela.cl',
    ]);
    expect(resolveConfig({ VITE_ALLOWED_DOMAIN: '@a.cl , b.cl' }).allowedDomains).toEqual(['a.cl', 'b.cl']);
    const many = Array.from({ length: 12 }, (_, i) => `d${i}.cl`).join(',');
    expect(resolveConfig({ ALLOWED_DOMAIN: many }).allowedDomains).toHaveLength(10);
  });

  it('readAllowedDomains tolerates old docs with allowedDomain', () => {
    expect(readAllowedDomains({ allowedDomains: ['ImpulseAI.cl', 'compratuparcela.cl', 'impulseai.cl'] })).toEqual([
      'impulseai.cl',
      'compratuparcela.cl',
    ]);
    expect(readAllowedDomains({ allowedDomain: ' CompraTuParcela.cl ' })).toEqual(['compratuparcela.cl']);
    // The list wins over the old field; an empty list falls back to the old field.
    expect(readAllowedDomains({ allowedDomains: ['a.cl'], allowedDomain: 'b.cl' })).toEqual(['a.cl']);
    expect(readAllowedDomains({ allowedDomains: [], allowedDomain: 'b.cl' })).toEqual(['b.cl']);
    expect(readAllowedDomains({ allowedDomains: [1, null] })).toEqual([]);
    expect(readAllowedDomains({ allowedDomain: '' })).toEqual([]);
    expect(readAllowedDomains({ allowedDomain: 5 })).toEqual([]);
    expect(readAllowedDomains({})).toEqual([]);
    expect(readAllowedDomains(null)).toEqual([]);
    expect(readAllowedDomains(undefined)).toEqual([]);
    expect(readAllowedDomains('impulseai.cl')).toEqual([]);
    expect(allowedDomainsOr(null, ['x.cl'])).toEqual(['x.cl']);
    expect(allowedDomainsOr({ allowedDomain: 'old.cl' }, ['x.cl'])).toEqual(['old.cl']);
    expect(allowedDomainsOr({}, [])).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
  });

  it('defaultOrgConfig', () => {
    expect(defaultOrgConfig(T0, ['Foo.cl', 'foo.cl']).allowedDomains).toEqual(['foo.cl']);
    expect(defaultOrgConfig(T0, []).allowedDomains).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
    expect(defaultOrgConfig(T0)).toEqual({
      allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
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
      'readAllowedDomains',
      'parseDomainList',
      'formatDomains',
      'DEFAULT_ALLOWED_DOMAINS',
      'COLLECTIONS',
      'SLOT_MS',
    ]) {
      expect(shared).toHaveProperty(name);
    }
  });
});
