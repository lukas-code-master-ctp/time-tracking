/// <reference types="node" />
// @vitest-environment node
/**
 * WCAG contrast of the timeline colors, computed from styles.css itself:
 * the ink (`--lvl-ink`) used for the % inside the cells, the chips and the
 * meeting marker must reach 4.5:1 (AA, small text) on every level color and
 * on the meeting color, in the light and dark themes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Read as a file: Vitest does not process CSS imports (`?raw` comes back empty).
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

/** Custom properties declared in the first block that starts with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no está ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  claro: tokens(':root'),
  'oscuro (sistema)': tokens(":root:not([data-theme='light'])"),
  'oscuro (forzado)': tokens(":root[data-theme='dark']"),
};

describe('timeline colors contrast', () => {
  it('contrast() matches known WCAG values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it.each(Object.entries(THEMES))('%s: ink ≥ 4.5:1 on every level and on "En reunión"', (_name, t) => {
    for (const level of ['--lvl-low', '--lvl-mid', '--lvl-high', '--lvl-meeting']) {
      expect(t[level], level).toMatch(/^#/);
      expect(contrast(t['--lvl-ink']!, t[level]!), level).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(Object.entries(THEMES))('%s: schedule shading ≥ 3:1 (graphics, WCAG 1.4.11) on the card', (_name, t) => {
    for (const token of ['--sch-off', '--sch-lunch']) {
      expect(t[token], token).toMatch(/^#/);
      expect(contrast(t[token]!, t['--surface']!), token).toBeGreaterThanOrEqual(3);
      expect(contrast(t[token]!, t['--surface-2']!), `${token} en surface-2`).toBeGreaterThanOrEqual(3);
    }
    // Outside the schedule and the lunch are told apart by hue too, not only by the stripe direction.
    expect(t['--sch-off']).not.toBe(t['--sch-lunch']);
    // The striped band on blocks with data uses the ink, already ≥ 4.5:1 on every level.
  });

  it.each(Object.entries(THEMES))('%s: entry/exit mark ≥ 3:1 on the card and on every block color (mark or its halo)', (_name, t) => {
    const mark = t['--sch-mark']!;
    const halo = t['--sch-mark-halo']!;
    expect(contrast(mark, halo)).toBeGreaterThanOrEqual(3);
    for (const bg of ['--surface', '--surface-2', '--lvl-none', '--lvl-low', '--lvl-mid', '--lvl-high', '--lvl-meeting']) {
      expect(Math.max(contrast(mark, t[bg]!), contrast(halo, t[bg]!)), bg).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(mark, t['--surface']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('the meeting color is its own (not one of the activity levels) and the same in both dark blocks', () => {
    for (const t of Object.values(THEMES)) {
      expect([t['--lvl-low'], t['--lvl-mid'], t['--lvl-high'], t['--lvl-none']]).not.toContain(t['--lvl-meeting']);
    }
    expect(THEMES['oscuro (sistema)']['--lvl-meeting']).toBe(THEMES['oscuro (forzado)']['--lvl-meeting']);
    // Values documented in styles.css.
    expect(contrast(THEMES.claro['--lvl-ink']!, THEMES.claro['--lvl-meeting']!)).toBeCloseTo(8.28, 1);
    expect(contrast(THEMES['oscuro (forzado)']['--lvl-ink']!, THEMES['oscuro (forzado)']['--lvl-meeting']!)).toBeCloseTo(5.75, 1);
  });
});
