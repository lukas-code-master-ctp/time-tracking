import { describe, expect, it } from 'vitest';
import { buildDailyReportReminder } from '../../src/core/dailyReportReminder.js';

describe('buildDailyReportReminder', () => {
  it('greets by first name and links to the phone page', () => {
    const m = buildDailyReportReminder({ to: 'ana@impulseai.cl', name: 'Ana Pérez', link: 'https://app.mipegahr.cl/terreno' });
    expect(m.to).toBe('ana@impulseai.cl');
    expect(m.subject).toBe('Envía tu minuta del día');
    expect(m.text).toContain('Hola, Ana:');
    expect(m.text).toContain('https://app.mipegahr.cl/terreno');
    expect(m.html).toContain('href="https://app.mipegahr.cl/terreno"');
  });

  it('escapes the name in the HTML', () => {
    const m = buildDailyReportReminder({ to: 'a@b.cl', name: '<b>Ana', link: 'https://x.test/terreno' });
    expect(m.html).toContain('&lt;b&gt;Ana');
    expect(buildDailyReportReminder({ to: 'a@b.cl', name: null, link: 'https://x.test' }).text).toMatch(/^Hola:/);
  });
});
