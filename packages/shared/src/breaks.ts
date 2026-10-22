/**
 * "Pausa activa" (spec 2026-10-21-pausa-activa): settings in `config/org` and
 * the exercises the extension suggests. Shared by extension and portal.
 */

/**
 * How the reminders are spread: `interval` after `intervalMinutes` of
 * continuous work; `daily` `perDay` times a day, spread over the working
 * hours of the day (spec 2026-10-22-pausa-activa-veces-al-dia).
 */
export type ActiveBreakMode = 'interval' | 'daily';

/** Settings of the active breaks of the organization. */
export interface ActiveBreakSettings {
  enabled: boolean;
  mode: ActiveBreakMode;
  /** Continuous work before a reminder (`interval`). */
  intervalMinutes: number;
  /** Reminders a day (`daily`). */
  perDay: number;
  /** How long the break lasts (also: away this long counts as a break). */
  durationMinutes: number;
}

/** Choices offered by the portal. */
export const ACTIVE_BREAK_INTERVAL_OPTIONS: readonly number[] = [45, 60, 90, 120];
export const ACTIVE_BREAK_DURATION_OPTIONS: readonly number[] = [3, 5, 10];
export const DEFAULT_ACTIVE_BREAK_INTERVAL_MINUTES = 60;
export const DEFAULT_ACTIVE_BREAK_MINUTES = 5;
export const ACTIVE_BREAK_PER_DAY_OPTIONS: readonly number[] = [2, 3, 4, 5, 6];
export const DEFAULT_ACTIVE_BREAKS_PER_DAY = 3;
/** Bounds accepted by firestore.rules (the portal only offers the options above). */
export const MIN_ACTIVE_BREAK_INTERVAL_MINUTES = 15;
export const MAX_ACTIVE_BREAK_INTERVAL_MINUTES = 240;
export const MIN_ACTIVE_BREAK_MINUTES = 1;
export const MAX_ACTIVE_BREAK_MINUTES = 15;
export const MIN_ACTIVE_BREAKS_PER_DAY = 1;
export const MAX_ACTIVE_BREAKS_PER_DAY = 12;

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Settings stored in a `config/org` document; missing or invalid fields = off / defaults. */
export function readActiveBreakSettings(config: unknown): ActiveBreakSettings {
  const c = (config && typeof config === 'object' ? config : {}) as {
    activeBreaksEnabled?: unknown;
    activeBreakMode?: unknown;
    activeBreakIntervalMinutes?: unknown;
    activeBreaksPerDay?: unknown;
    activeBreakMinutes?: unknown;
  };
  return {
    enabled: c.activeBreaksEnabled === true,
    mode: c.activeBreakMode === 'daily' ? 'daily' : 'interval',
    intervalMinutes: intIn(c.activeBreakIntervalMinutes, MIN_ACTIVE_BREAK_INTERVAL_MINUTES, MAX_ACTIVE_BREAK_INTERVAL_MINUTES)
      ? c.activeBreakIntervalMinutes
      : DEFAULT_ACTIVE_BREAK_INTERVAL_MINUTES,
    perDay: intIn(c.activeBreaksPerDay, MIN_ACTIVE_BREAKS_PER_DAY, MAX_ACTIVE_BREAKS_PER_DAY)
      ? c.activeBreaksPerDay
      : DEFAULT_ACTIVE_BREAKS_PER_DAY,
    durationMinutes: intIn(c.activeBreakMinutes, MIN_ACTIVE_BREAK_MINUTES, MAX_ACTIVE_BREAK_MINUTES)
      ? c.activeBreakMinutes
      : DEFAULT_ACTIVE_BREAK_MINUTES,
  };
}

/**
 * Instants of the `perDay` reminders of a day in `daily` mode: the working
 * time of `work` (the windows of the day, lunch excluded, in order) split in
 * `perDay + 1` equal parts; the i-th reminder at the end of the i-th part.
 * E.g. 9:00–18:00 with lunch 13:00–14:00 and 3 a day: 11:00, 14:00, 16:00.
 */
export function dailyBreakTargets(work: readonly { start: number; end: number }[], perDay: number): number[] {
  const total = work.reduce((sum, w) => sum + Math.max(0, w.end - w.start), 0);
  const n = Math.floor(perDay);
  if (!(total > 0) || !(n >= 1)) return [];
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    let left = Math.round((total * i) / (n + 1));
    for (const w of work) {
      const len = Math.max(0, w.end - w.start);
      if (left < len) {
        out.push(w.start + left);
        break;
      }
      left -= len;
    }
  }
  return out;
}

export interface ActiveBreakExercise {
  id: string;
  title: string;
  /** What to do, one or two short sentences (fits a notification). */
  text: string;
}

/** Suggested exercises, in the order they rotate. Ids are stored in `breaks`: never change them. */
export const ACTIVE_BREAK_EXERCISES: readonly ActiveBreakExercise[] = [
  {
    id: 'cuello',
    title: 'Estira el cuello',
    text: 'Inclina la cabeza hacia cada hombro y mantén 15 segundos por lado. Luego gira los hombros hacia atrás 10 veces.',
  },
  {
    id: 'vista',
    title: 'Descansa la vista (20-20-20)',
    text: 'Mira algo a unos 6 metros durante 20 segundos y parpadea varias veces. Repite 3 veces.',
  },
  {
    id: 'munecas',
    title: 'Muñecas y manos',
    text: 'Con el brazo estirado, tira suave de los dedos hacia abajo 15 segundos por mano. Abre y cierra los puños 10 veces.',
  },
  {
    id: 'caminar',
    title: 'Ponte de pie y camina',
    text: 'Levántate y camina un par de minutos. Aprovecha de tomar agua.',
  },
  {
    id: 'espalda',
    title: 'Estira la espalda',
    text: 'De pie, entrelaza los dedos y estira los brazos hacia arriba 15 segundos. Luego inclínate suave a cada lado.',
  },
  {
    id: 'hombros',
    title: 'Abre el pecho',
    text: 'Entrelaza las manos detrás de la espalda y lleva los hombros hacia atrás 20 segundos. Repite 3 veces.',
  },
  {
    id: 'respirar',
    title: 'Respira profundo',
    text: 'Inhala por la nariz 4 segundos, mantén 4 y exhala en 6. Repite 5 veces.',
  },
  {
    id: 'piernas',
    title: 'Activa las piernas',
    text: 'Haz 10 sentadillas suaves o 20 elevaciones de talones apoyándote en la silla.',
  },
];

/** The exercise of the `n`-th reminder (rotates). */
export function exerciseAt(n: number): ActiveBreakExercise {
  const list = ACTIVE_BREAK_EXERCISES;
  const i = ((Math.floor(n) % list.length) + list.length) % list.length;
  return list[i]!;
}

/**
 * `daily` mode: the exercise of the `index`-th reminder (0-based) of `date`
 * (YYYY-MM-DD). The same for everyone, so the portal can show the plan of
 * the day; it keeps rotating from one day to the next.
 */
export function dailyExercise(date: string, index: number, perDay: number): ActiveBreakExercise {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  return exerciseAt(day * Math.max(1, Math.floor(perDay)) + index);
}

/** Exercise by id (unknown ids, e.g. from a newer version: null). */
export function exerciseById(id: string): ActiveBreakExercise | null {
  return ACTIVE_BREAK_EXERCISES.find((e) => e.id === id) ?? null;
}
