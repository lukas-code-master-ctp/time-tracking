/**
 * The animation of each active break exercise as an SVG string (spec
 * 2026-11-12-biblioteca-pausas). Pure CSS keyframes inside the SVG: no
 * scripts, no images, works in the extension popup and the portal.
 *
 * Colors come from the page: strokes are `currentColor`, highlights use the
 * `--accent` and `--accent-soft` custom properties (with the brand colors as
 * fallback). With `prefers-reduced-motion` the drawing stays on its first
 * pose.
 */
import type { ActiveBreakExercise, ExerciseArt, FigureProp, FigureView, Pose } from './exercises.js';

const ACCENT = 'var(--accent, #26336b)';
const SOFT = 'var(--accent-soft, #e8ebf7)';

export interface ExerciseArtOptions {
  /**
   * Seconds since some fixed instant (default: the clock). Animations start
   * that far into their loop, so a view that redraws itself every few seconds
   * (the popup) does not restart them.
   */
  elapsedSeconds?: number;
  /** Accessible name of the picture (default: the exercise title). */
  label?: string;
}

let counter = 0;

interface Ctx {
  u: string;
  css: string[];
  elapsed: number;
}

type Stop = [percent: number, value: string];

/** A CSS animation on class `cls` (rotation/translation about `origin`); `first` holds when motion is reduced. */
function animate(ctx: Ctx, cls: string, seconds: number, stops: Stop[], origin: [number, number] = [0, 0], timing = 'ease-in-out'): void {
  const name = `${ctx.u}-${cls}`;
  const frames = stops.map(([p, v]) => `${round(p)}%{${v}}`).join('');
  const delay = -round(ctx.elapsed % seconds);
  ctx.css.push(
    `@keyframes ${name}{${frames}}`,
    `.${ctx.u} .${cls}{transform-box:view-box;transform-origin:${origin[0]}px ${origin[1]}px;${stops[0]![1]};` +
      `animation:${name} ${round(seconds)}s ${timing} ${delay}s infinite}`,
  );
}

/** A static transform (nothing moves). */
function still(ctx: Ctx, cls: string, value: string, origin: [number, number] = [0, 0]): void {
  ctx.css.push(`.${ctx.u} .${cls}{transform-box:view-box;transform-origin:${origin[0]}px ${origin[1]}px;${value}}`);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Stops of a loop through `values`: each one held a while, then eased into the next, back to the first. */
function holdStops(values: string[]): Stop[] {
  const n = values.length;
  const seg = 100 / n;
  const stops: Stop[] = [];
  values.forEach((v, i) => {
    stops.push([i * seg, v], [i * seg + seg * 0.55, v]);
  });
  stops.push([100, values[0]!]);
  return stops;
}

/** Animate `cls` through `values` (or leave it still when they are all the same). */
function joint(ctx: Ctx, cls: string, seconds: number, values: string[], origin: [number, number]): void {
  if (values.every((v) => v === values[0])) still(ctx, cls, values[0]!, origin);
  else animate(ctx, cls, seconds, holdStops(values), origin);
}

// ---------------------------------------------------------------- figure

const BASE: Partial<Record<FigureView, Pose>> = {
  chair: { legL: -90, shinL: 90, legR: -90, shinR: 90 },
  desk: { armL: 22, foreL: -40, armR: -22, foreR: 40 },
};

/**
 * Where the figure stands in each view: the viewBox of a nested `<svg>` in
 * skeleton coordinates (hips at 60,66). A nested viewport (not a scaled
 * group) keeps the joints' `transform-origin` in skeleton coordinates.
 */
const PLACE: Record<FigureView, string> = {
  front: '0 0 120 120',
  side: '6 0 120 120',
  desk: '17.143 4.571 85.714 85.714',
  chair: '11.786 -5.857 107.143 107.143',
};

const LINE = 'fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"';

function line(x1: number, y1: number, x2: number, y2: number, extra = ''): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${LINE}${extra}/>`;
}

function propSvg(prop: FigureProp | undefined, view: FigureView): string {
  const thin = 'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity=".45"';
  const parts: string[] = [];
  if (view === 'front' || view === 'side') parts.push(`<line x1="16" y1="108" x2="108" y2="108" ${thin}/>`);
  if (prop === 'table') parts.push(`<path d="M72 64H108M102 64V108M78 64V108" ${thin}/>`);
  if (prop === 'wall') parts.push(`<path d="M94 14V108" ${thin}/><path d="M94 14V108" stroke="${SOFT}" stroke-width="8" opacity=".9"/>`);
  if (prop === 'door') parts.push(`<path d="M78 12V108M78 12H112M112 12V108" ${thin}/>`);
  if (prop === 'stairs') parts.push(`<path d="M78 108V99H88V90H98V81H112" ${thin}/>`);
  return parts.join('');
}

function figure(ctx: Ctx, art: Extract<ExerciseArt, { kind: 'figure' }>, closedEyes = false): string {
  const { view } = art;
  const side = view === 'side' || view === 'chair';
  const base = BASE[view] ?? {};
  const frames = (art.frames.length > 0 ? art.frames : [{}]).map((f) => ({ ...base, ...f }));
  const val = (k: keyof Pose): number[] => frames.map((f) => f[k] ?? 0);
  const rot = (k: keyof Pose) => val(k).map((v) => `transform:rotate(${v}deg)`);
  const s = art.seconds;

  // Skeleton (before the view's translation).
  const N = [60, 38] as const;
  const H = [60, 66] as const;
  const SL: [number, number] = side ? [60, 42] : [52, 42];
  const SR: [number, number] = side ? [60, 42] : [68, 42];
  const HL: [number, number] = side ? [60, 66] : [55, 66];
  const HR: [number, number] = side ? [60, 66] : [65, 66];

  joint(ctx, 'b', s, val('y').map((v) => `transform:translateY(${v}px)`), [0, 0]);
  joint(ctx, 't', s, rot('torso'), [H[0], H[1]]);
  joint(ctx, 'sh', s, val('shrug').map((v) => `transform:translateY(${v}px)`), [0, 0]);
  joint(ctx, 'hx', s, val('headX').map((v) => `transform:translateX(${v}px)`), [0, 0]);
  joint(ctx, 'h', s, rot('head'), [N[0], N[1]]);
  joint(ctx, 'lk', s, val('look').map((v) => `transform:translateX(${v * 3.5}px)`), [0, 0]);
  for (const side_ of ['L', 'R'] as const) {
    const S = side_ === 'L' ? SL : SR;
    const Hp = side_ === 'L' ? HL : HR;
    joint(ctx, `a${side_}`, s, rot(`arm${side_}`), S);
    joint(ctx, `f${side_}`, s, rot(`fore${side_}`), [S[0], S[1] + 15]);
    joint(ctx, `l${side_}`, s, rot(`leg${side_}`), Hp);
    joint(ctx, `s${side_}`, s, rot(`shin${side_}`), [Hp[0], Hp[1] + 20]);
    joint(ctx, `p${side_}`, s, rot(`foot${side_}`), [Hp[0], Hp[1] + 40]);
  }

  const far = side ? ' opacity=".45"' : '';
  const arm = (k: 'L' | 'R', S: [number, number], extra: string) =>
    `<g class="a${k}">${line(S[0], S[1], S[0], S[1] + 15, extra)}<g class="f${k}">${line(S[0], S[1] + 15, S[0], S[1] + 29, extra)}</g></g>`;
  const leg = (k: 'L' | 'R', P: [number, number], extra: string) =>
    `<g class="l${k}">${line(P[0], P[1], P[0], P[1] + 20, extra)}<g class="s${k}">${line(P[0], P[1] + 20, P[0], P[1] + 40, extra)}` +
    `<g class="p${k}">${side ? line(P[0], P[1] + 40, P[0] + 7, P[1] + 40, extra) : ''}</g></g></g>`;

  const eyes = closedEyes
    ? side
      ? '<path d="M62 27q2 1.5 4 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      : '<path d="M55.5 27q2 1.5 4 0M60.5 27q2 1.5 4 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    : side
      ? '<circle cx="64" cy="26.5" r="1.5" fill="currentColor"/>'
      : '<circle cx="57" cy="27" r="1.5" fill="currentColor"/><circle cx="63" cy="27" r="1.5" fill="currentColor"/>';
  const nose = side ? '<path d="M68.2 27.5l2.3 2.5-2.6.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' : '';
  const head =
    `<g class="hx"><g class="h">${line(60, 41, 60, 37)}` +
    `<circle cx="60" cy="27.5" r="8.5" fill="${SOFT}" stroke="currentColor" stroke-width="3.5"/>` +
    `<g class="lk">${eyes}${nose}</g></g></g>`;
  const torso = side ? line(60, 41, 60, 66) : `${line(60, 41, 60, 66)}${line(SL[0], SL[1], SR[0], SR[1])}${line(HL[0], 66, HR[0], 66)}`;

  const body =
    `<g class="b">${leg('L', HL, far)}<g class="t"><g class="sh">${arm('L', SL, far)}</g>${torso}${head}` +
    `<g class="sh">${arm('R', SR, '')}</g></g>${leg('R', HR, '')}</g>`;

  const chair =
    view === 'chair'
      ? '<path d="M44 40V69M42 69H76M46 69V87M74 69V87M18 87.5H112" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity=".45"/>'
      : '';
  const desk =
    view === 'desk'
      ? `<rect x="8" y="86" width="104" height="34" rx="3" fill="${SOFT}"/><path d="M8 86H112" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".55"/>` +
        '<path d="M42 86l5-13h24l-5 13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" opacity=".45"/>'
      : '';
  return `${propSvg(art.prop, view)}<svg x="0" y="0" width="120" height="120" viewBox="${PLACE[view]}" overflow="visible">${chair}${body}</svg>${desk}`;
}

// ---------------------------------------------------------------- eyes

const EYE = 'M24 62Q60 28 96 62Q60 96 24 62Z';

function eyes(ctx: Ctx, pattern: Extract<ExerciseArt, { kind: 'eyes' }>['pattern']): string {
  const clip = `${ctx.u}-clip`;
  let lid: Stop[] | null = null; // eyelid scaleY
  let iris: { seconds: number; points: [number, number][]; linear?: boolean } | null = null;
  let pupil: string[] | null = null;
  let extra = '';
  let cover = '';
  let lidSeconds = 6;
  const blinkAt = (pct: number): Stop[] => [
    [0, 'transform:scaleY(0)'],
    [pct, 'transform:scaleY(0)'],
    [pct + 3, 'transform:scaleY(1)'],
    [pct + 6, 'transform:scaleY(0)'],
    [100, 'transform:scaleY(0)'],
  ];
  const mountain = (x: number, y: number) =>
    `<path d="M${x} ${y}l9-11 6 6 5-5 9 10" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  switch (pattern) {
    case 'far':
      extra = `${mountain(80, 22)}<text x="100" y="34" font-size="9" text-anchor="middle" fill="currentColor" opacity=".7">6 m</text>`;
      iris = { seconds: 6, points: [[0, 0], [11, -6]] };
      pupil = ['transform:scale(1)', 'transform:scale(.7)'];
      lid = blinkAt(80);
      break;
    case 'window':
      extra =
        `<rect x="80" y="4" width="32" height="26" rx="2" fill="none" stroke="currentColor" stroke-width="2.5" opacity=".55"/>` +
        `<path d="M96 4V30M80 17H112" stroke="currentColor" stroke-width="2" opacity=".4"/>${mountain(82, 28)}`;
      iris = { seconds: 6, points: [[0, 0], [12, -8]] };
      pupil = ['transform:scale(1)', 'transform:scale(.7)'];
      lid = blinkAt(84);
      break;
    case 'near-far':
      extra =
        `<path d="M22 118V100" stroke="currentColor" stroke-width="8" stroke-linecap="round" opacity=".7"/>${mountain(80, 22)}`;
      iris = { seconds: 6, points: [[-11, 7], [11, -6]] };
      pupil = ['transform:scale(1.2)', 'transform:scale(.7)'];
      break;
    case 'blink':
      lidSeconds = 3;
      lid = holdStops(['transform:scaleY(0)', 'transform:scaleY(1)']);
      break;
    case 'eight':
      iris = {
        seconds: 6,
        linear: true,
        points: [[0, 0], [9, -6], [17, 0], [9, 6], [0, 0], [-9, -6], [-17, 0], [-9, 6]],
      };
      break;
    case 'cross':
      iris = { seconds: 8, points: [[0, -10], [0, 0], [0, 10], [0, 0], [-17, 0], [0, 0], [17, 0], [0, 0]] };
      break;
    case 'palm':
      lid = [[0, 'transform:scaleY(1)'], [100, 'transform:scaleY(1)']];
      for (const [cls, from, to] of [['pl', -62, 0], ['pr', 62, 0]] as const) {
        animate(ctx, cls, 6, holdStops([`transform:translateX(${from}px)`, `transform:translateX(${to}px)`]));
      }
      cover =
        `<g class="pl"><rect x="6" y="30" width="52" height="66" rx="22" fill="${ACCENT}" opacity=".85"/></g>` +
        `<g class="pr"><rect x="62" y="30" width="52" height="66" rx="22" fill="${ACCENT}" opacity=".85"/></g>`;
      break;
    case 'closed':
      lid = [[0, 'transform:scaleY(1)'], [100, 'transform:scaleY(1)']];
      animate(ctx, 'zz', 5, [[0, 'opacity:.15'], [50, 'opacity:.8'], [100, 'opacity:.15']]);
      extra = `<g class="zz"><path d="M40 22q20-12 40 0M48 12q12-7 24 0" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/></g>`;
      break;
  }
  if (iris) {
    const values = iris.points.map(([x, y]) => `transform:translate(${x}px,${y}px)`);
    if (iris.linear) {
      const n = values.length;
      animate(ctx, 'ir', iris.seconds, [...values.map((v, i): Stop => [(i * 100) / n, v]), [100, values[0]!]], [0, 0], 'linear');
    } else animate(ctx, 'ir', iris.seconds, holdStops(values));
  } else still(ctx, 'ir', 'transform:none');
  if (pupil && iris) animate(ctx, 'pu', iris.seconds, holdStops(pupil), [60, 62]);
  else still(ctx, 'pu', 'transform:none', [60, 62]);
  if (lid) animate(ctx, 'lid', lidSeconds, lid, [60, 28]);
  else still(ctx, 'lid', 'transform:scaleY(0)', [60, 28]);

  return (
    `<defs><clipPath id="${clip}"><path d="${EYE}"/></clipPath></defs>${extra}` +
    `<path d="${EYE}" fill="#fff" stroke="none"/>` +
    `<g clip-path="url(#${clip})"><g class="ir"><circle cx="60" cy="62" r="15" fill="${ACCENT}"/>` +
    `<g class="pu"><circle cx="60" cy="62" r="6" fill="#0b1120"/></g><circle cx="65" cy="57" r="3" fill="#fff" opacity=".85"/></g>` +
    `<g class="lid"><rect x="20" y="28" width="80" height="70" fill="${SOFT}"/><path d="M24 98Q60 96 96 98" stroke="currentColor" stroke-width="3.5"/></g></g>` +
    `<path d="${EYE}" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/>${cover}`
  );
}

// ---------------------------------------------------------------- breath

function breathArt(ctx: Ctx, steps: Extract<ExerciseArt, { kind: 'breath' }>['steps']): string {
  const total = steps.reduce((a, s) => a + s.seconds, 0);
  const scale: Stop[] = [[0, `transform:scale(${steps[steps.length - 1]!.scale})`]];
  let t = 0;
  const labels: string[] = [];
  steps.forEach((step, i) => {
    const start = (t / total) * 100;
    t += step.seconds;
    const end = (t / total) * 100;
    scale.push([end, `transform:scale(${step.scale})`]);
    const stops: Stop[] = start === 0 ? [[0, 'opacity:1'], [end, 'opacity:0']] : [[0, 'opacity:0'], [start, 'opacity:1'], [end, 'opacity:0']];
    stops.push([100, 'opacity:0']);
    animate(ctx, `lb${i}`, total, stops, [0, 0], 'step-end');
    labels.push(
      `<g class="lb${i}"><text x="60" y="112" font-size="12" font-weight="600" text-anchor="middle" fill="currentColor">${esc(step.label)}</text>` +
        `<text x="60" y="58.5" font-size="13" font-weight="700" text-anchor="middle" fill="${ACCENT}">${round(step.seconds)}</text></g>`,
    );
  });
  animate(ctx, 'ci', total, scale, [60, 54]);
  return (
    `<circle cx="60" cy="54" r="40" fill="${SOFT}"/>` +
    `<g class="ci"><circle cx="60" cy="54" r="38" fill="none" stroke="${ACCENT}" stroke-width="4"/></g>` +
    `<circle cx="60" cy="54" r="12" fill="${SOFT}" stroke="${ACCENT}" stroke-width="1.5" opacity=".9"/>${labels.join('')}`
  );
}

// ---------------------------------------------------------------- hand

function hand(ctx: Ctx, pattern: Extract<ExerciseArt, { kind: 'hand' }>['pattern']): string {
  const stroke = 'stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
  if (pattern === 'fan' || pattern === 'thumb') {
    // Palm from the front.
    const bases: [number, number, number][] = [
      [47, 60, 20],
      [55.5, 57, 25],
      [64.5, 57, 24],
      [73, 60, 19],
    ];
    const spread = [-16, -6, 6, 16];
    bases.forEach(([x, y], i) => {
      if (pattern === 'fan') animate(ctx, `fi${i}`, 4, holdStops(['transform:rotate(0deg)', `transform:rotate(${spread[i]}deg)`]), [x, y]);
      else {
        const values = bases.map((_, k) => (k === i ? 'transform:scaleY(.45)' : 'transform:scaleY(1)'));
        animate(ctx, `fi${i}`, 5, holdStops(values), [x, y]);
      }
    });
    if (pattern === 'fan') animate(ctx, 'th', 4, holdStops(['transform:rotate(-4deg)', 'transform:rotate(-38deg)']), [46, 86]);
    else animate(ctx, 'th', 5, holdStops(['transform:rotate(62deg)', 'transform:rotate(74deg)', 'transform:rotate(86deg)', 'transform:rotate(98deg)']), [46, 86]);
    const fingers = bases
      .map(([x, y, len], i) => `<g class="fi${i}"><line x1="${x}" y1="${y}" x2="${x}" y2="${y - len}" stroke-width="8" ${stroke}/></g>`)
      .join('');
    return (
      `<rect x="50" y="92" width="20" height="28" fill="${SOFT}" stroke="currentColor" stroke-width="3"/>` +
      `<rect x="42" y="56" width="36" height="40" rx="11" fill="${SOFT}" stroke="currentColor" stroke-width="3.5"/>` +
      `${fingers}<g class="th"><line x1="46" y1="86" x2="46" y2="64" stroke-width="8" ${stroke}/></g>`
    );
  }
  // Arm and hand from the side, the wrist at (64, 62).
  const fist = pattern === 'rotate';
  const values =
    pattern === 'pull-down'
      ? ['transform:rotate(0deg)', 'transform:rotate(58deg)']
      : pattern === 'pull-up'
        ? ['transform:rotate(0deg)', 'transform:rotate(-58deg)']
        : pattern === 'rotate'
          ? ['transform:rotate(-35deg)', 'transform:rotate(0deg)', 'transform:rotate(35deg)', 'transform:rotate(0deg)']
          : ['transform:rotate(-18deg)', 'transform:rotate(18deg)'];
  const seconds = pattern === 'shake' ? 0.5 : pattern === 'rotate' ? 3 : 5;
  if (pattern === 'shake') animate(ctx, 'hd', seconds, [[0, values[0]!], [50, values[1]!], [100, values[0]!]], [64, 62]);
  else animate(ctx, 'hd', seconds, holdStops(values), [64, 62]);
  const handSvg = fist
    ? `<rect x="64" y="52" width="22" height="22" rx="8" fill="${SOFT}" stroke="currentColor" stroke-width="3.5"/>`
    : `<rect x="64" y="54" width="20" height="17" rx="6" fill="${SOFT}" stroke="currentColor" stroke-width="3.5"/>` +
      `<line x1="84" y1="60" x2="104" y2="60" stroke-width="8" ${stroke}/><line x1="80" y1="56" x2="88" y2="48" stroke-width="6.5" ${stroke}/>`;
  const arrow =
    pattern === 'pull-down'
      ? `<path d="M100 76q2 14-10 22" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/><path d="M89 92l1 6 6-1" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
      : pattern === 'pull-up'
        ? `<path d="M100 46q2-14-10-22" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/><path d="M89 30l1-6 6 1" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
        : pattern === 'rotate'
          ? `<path d="M76 34a28 28 0 0 1 22 18" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/><path d="M76 90a28 28 0 0 0 22-18" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/>`
          : '';
  return (
    `${arrow}<rect x="6" y="55" width="60" height="14" rx="6" fill="${SOFT}" stroke="currentColor" stroke-width="3.5"/>` +
    `<g class="hd">${handSvg}</g>`
  );
}

// ---------------------------------------------------------------- scan

function scan(ctx: Ctx): string {
  animate(ctx, 'bd', 6, [[0, 'transform:translateY(0px)'], [85, 'transform:translateY(-70px)'], [100, 'transform:translateY(-70px)']], [0, 0], 'linear');
  animate(ctx, 'bdo', 6, [[0, 'opacity:0'], [8, 'opacity:.55'], [80, 'opacity:.55'], [92, 'opacity:0'], [100, 'opacity:0']], [0, 0], 'linear');
  const person = figure(ctx, { kind: 'figure', view: 'desk', seconds: 6, frames: [{}] }, true);
  return `${person}<g class="bdo"><g class="bd"><rect x="26" y="80" width="68" height="10" rx="5" fill="${ACCENT}"/></g></g>`;
}

// ---------------------------------------------------------------- entry

/**
 * The animation of `exercise` as an `<svg>` string (viewBox 120×120, it
 * scales to its box: give it a width). Safe to set as innerHTML: it holds no
 * text from users.
 */
export function exerciseArt(exercise: Pick<ActiveBreakExercise, 'title' | 'art'>, opts: ExerciseArtOptions = {}): string {
  counter = (counter + 1) % 1_000_000;
  const ctx: Ctx = { u: `pa${counter.toString(36)}`, css: [], elapsed: opts.elapsedSeconds ?? Date.now() / 1000 };
  const art = exercise.art;
  const body =
    art.kind === 'figure'
      ? figure(ctx, art)
      : art.kind === 'eyes'
        ? eyes(ctx, art.pattern)
        : art.kind === 'breath'
          ? breathArt(ctx, art.steps)
          : art.kind === 'hand'
            ? hand(ctx, art.pattern)
            : scan(ctx);
  const css = `${ctx.css.join('')}@media (prefers-reduced-motion:reduce){.${ctx.u} *{animation:none!important}}`;
  return (
    `<svg class="exercise-art ${ctx.u}" viewBox="0 0 120 120" role="img" aria-label="${esc(opts.label ?? exercise.title)}" xmlns="http://www.w3.org/2000/svg">` +
    `<style>${css}</style>${body}</svg>`
  );
}
