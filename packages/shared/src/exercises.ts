/**
 * The library of active break exercises (spec 2026-11-12-biblioteca-pausas):
 * 56 exercises in 7 zones, reviewed by Lukas on 2026-11-12. Each one carries
 * the drawing of its animation (`art`, rendered by `exerciseArt`).
 *
 * Ids are stored in `breaks/{id}.exercise`: never change or reuse them. The
 * first 8 ids are the exercises of extension ≤ 0.2.25.
 */

export type ExerciseZone = 'cuello' | 'vista' | 'manos' | 'espalda' | 'piernas' | 'respiracion' | 'movilidad';

/** The zones in the order the rotation visits them (no two alike in a row). */
export const EXERCISE_ZONES: readonly { id: ExerciseZone; label: string }[] = [
  { id: 'cuello', label: 'Cuello y hombros' },
  { id: 'piernas', label: 'Piernas y circulación' },
  { id: 'vista', label: 'Vista' },
  { id: 'espalda', label: 'Espalda y pecho' },
  { id: 'respiracion', label: 'Respiración y calma' },
  { id: 'manos', label: 'Manos y muñecas' },
  { id: 'movilidad', label: 'Movilidad de pie y caminar' },
];

export type ExercisePosture = 'sentado' | 'de pie' | 'sentado o de pie' | 'sentado y de pie';

/**
 * A pose of the stick figure: joint angles in degrees (0 = the limb hangs
 * straight down; positive turns clockwise on screen). `L` limbs are on the
 * left of the picture (in side views: the far side, drawn lighter); forearms,
 * shins and feet are relative to the limb above. `y` moves the whole body
 * down (squats), `shrug` the shoulders, `headX` the head back and forth,
 * `look` the face to the sides (-1…1).
 */
export interface Pose {
  torso?: number;
  head?: number;
  headX?: number;
  look?: number;
  shrug?: number;
  y?: number;
  armL?: number;
  foreL?: number;
  armR?: number;
  foreR?: number;
  legL?: number;
  shinL?: number;
  footL?: number;
  legR?: number;
  shinR?: number;
  footR?: number;
}

/**
 * - `desk`: from the front, seated behind a desk (legs hidden).
 * - `front`: standing, from the front.
 * - `side`: standing, side view facing right.
 * - `chair`: seated on a chair, side view facing right.
 */
export type FigureView = 'desk' | 'front' | 'side' | 'chair';
export type FigureProp = 'table' | 'wall' | 'door' | 'stairs';

export type ExerciseArt =
  | { kind: 'figure'; view: FigureView; prop?: FigureProp; seconds: number; frames: Pose[] }
  | { kind: 'eyes'; pattern: 'far' | 'near-far' | 'palm' | 'blink' | 'eight' | 'cross' | 'window' | 'closed' }
  | { kind: 'breath'; steps: { label: string; seconds: number; scale: number }[] }
  | { kind: 'hand'; pattern: 'pull-down' | 'pull-up' | 'rotate' | 'fan' | 'thumb' | 'shake' }
  | { kind: 'scan' };

export interface ActiveBreakExercise {
  id: string;
  title: string;
  /** What to do, one or two short sentences (fits a notification). */
  text: string;
  zone: ExerciseZone;
  posture: ExercisePosture;
  art: ExerciseArt;
}

const fig = (view: FigureView, seconds: number, frames: Pose[], prop?: FigureProp): ExerciseArt =>
  prop ? { kind: 'figure', view, prop, seconds, frames } : { kind: 'figure', view, seconds, frames };
const breath = (...steps: [string, number, number][]): ExerciseArt => ({
  kind: 'breath',
  steps: steps.map(([label, seconds, scale]) => ({ label, seconds, scale })),
});

/** Seated with the hands on the thighs (side view). */
const HANDS_ON_KNEES: Pose = { armL: -35, foreL: -40, armR: -35, foreR: -40 };
/** Hands on the waist, from the front. */
const HANDS_ON_WAIST: Pose = { armL: 40, foreL: -115, armR: -40, foreR: 115 };
const WALK_A: Pose = { legR: -25, shinR: 10, legL: 22, shinL: 15, armR: 25, armL: -25 };
const WALK_B: Pose = { legL: -25, shinL: 10, legR: 22, shinR: 15, armL: 25, armR: -25 };

/** Every exercise; the rotation picks them by zone (see `exerciseAt`). */
export const ACTIVE_BREAK_EXERCISES: readonly ActiveBreakExercise[] = [
  // The 8 exercises of extension ≤ 0.2.25 (same ids and texts).
  {
    id: 'cuello',
    title: 'Estira el cuello',
    text: 'Inclina la cabeza hacia cada hombro y mantén 15 segundos por lado. Luego gira los hombros hacia atrás 10 veces.',
    zone: 'cuello',
    posture: 'sentado',
    art: fig('desk', 8, [{}, { head: -34 }, {}, { head: 34 }]),
  },
  {
    id: 'vista',
    title: 'Descansa la vista (20-20-20)',
    text: 'Mira algo a unos 6 metros durante 20 segundos y parpadea varias veces. Repite 3 veces.',
    zone: 'vista',
    posture: 'sentado',
    art: { kind: 'eyes', pattern: 'far' },
  },
  {
    id: 'munecas',
    title: 'Muñecas y manos',
    text: 'Con el brazo estirado, tira suave de los dedos hacia abajo 15 segundos por mano. Abre y cierra los puños 10 veces.',
    zone: 'manos',
    posture: 'sentado',
    art: { kind: 'hand', pattern: 'pull-down' },
  },
  {
    id: 'caminar',
    title: 'Ponte de pie y camina',
    text: 'Levántate y camina un par de minutos. Aprovecha de tomar agua.',
    zone: 'movilidad',
    posture: 'de pie',
    art: fig('side', 1.6, [WALK_A, WALK_B]),
  },
  {
    id: 'espalda',
    title: 'Estira la espalda',
    text: 'De pie, entrelaza los dedos y estira los brazos hacia arriba 15 segundos. Luego inclínate suave a cada lado.',
    zone: 'espalda',
    posture: 'de pie',
    art: fig('front', 8, [
      { armL: 170, foreL: 15, armR: -170, foreR: -15 },
      { armL: 170, foreL: 15, armR: -170, foreR: -15, torso: -14 },
      { armL: 170, foreL: 15, armR: -170, foreR: -15 },
      { armL: 170, foreL: 15, armR: -170, foreR: -15, torso: 14 },
    ]),
  },
  {
    id: 'hombros',
    title: 'Abre el pecho',
    text: 'Entrelaza las manos detrás de la espalda y lleva los hombros hacia atrás 20 segundos. Repite 3 veces.',
    zone: 'espalda',
    posture: 'de pie',
    art: fig('side', 5, [{ armL: 15, armR: 15 }, { armL: 40, armR: 40, torso: -6, head: -8 }]),
  },
  {
    id: 'respirar',
    title: 'Respira profundo',
    text: 'Inhala por la nariz 4 segundos, mantén 4 y exhala en 6. Repite 5 veces.',
    zone: 'respiracion',
    posture: 'sentado',
    art: breath(['Inhala', 4, 1], ['Mantén', 4, 1], ['Exhala', 6, 0.55]),
  },
  {
    id: 'piernas',
    title: 'Activa las piernas',
    text: 'Haz 10 sentadillas suaves o 20 elevaciones de talones apoyándote en la silla.',
    zone: 'piernas',
    posture: 'de pie',
    art: fig('side', 3, [
      { armR: -10, armL: -10 },
      { y: 14, torso: 25, legL: -60, shinL: 100, legR: -60, shinR: 100, armL: -85, armR: -85, footL: -40, footR: -40 },
    ]),
  },

  // Cuello y hombros
  {
    id: 'mirar-hombro',
    title: 'Mira por encima del hombro',
    text: 'Gira la cabeza despacio hacia un lado como si miraras atrás, mantén 10 segundos y cambia. 3 veces por lado.',
    zone: 'cuello',
    posture: 'sentado',
    art: fig('desk', 7, [{}, { look: -1 }, {}, { look: 1 }]),
  },
  {
    id: 'si-cabeza',
    title: 'Sí con la cabeza',
    text: 'Baja el mentón al pecho y súbelo hasta mirar al frente, lento, 10 veces. Sin echar la cabeza hacia atrás.',
    zone: 'cuello',
    posture: 'sentado',
    art: fig('chair', 4, [HANDS_ON_KNEES, { ...HANDS_ON_KNEES, head: 32 }]),
  },
  {
    id: 'menton-atras',
    title: 'Mentón hacia atrás',
    text: 'Lleva el mentón hacia atrás como haciendo papada, sin bajar la cabeza. Mantén 5 segundos, 10 veces.',
    zone: 'cuello',
    posture: 'sentado',
    art: fig('chair', 4, [{ ...HANDS_ON_KNEES, headX: 2 }, { ...HANDS_ON_KNEES, headX: -4 }]),
  },
  {
    id: 'hombros-arriba',
    title: 'Sube y suelta los hombros',
    text: 'Sube los hombros hacia las orejas, mantén 3 segundos y suéltalos de golpe. 10 veces.',
    zone: 'cuello',
    posture: 'sentado',
    art: fig('desk', 3, [{}, { shrug: -6 }]),
  },
  {
    id: 'oreja-hombro',
    title: 'Oreja al hombro con ayuda',
    text: 'Inclina la cabeza a un lado y apoya suave esa mano sobre la cabeza, sin tirar. 20 segundos por lado.',
    zone: 'cuello',
    posture: 'sentado',
    art: fig('desk', 8, [{}, { head: 26, armR: -165, foreR: -80 }, {}, { head: -26, armL: 165, foreL: 80 }]),
  },
  {
    id: 'brazo-cruzado',
    title: 'Brazo cruzado',
    text: 'Cruza un brazo frente al pecho y sostenlo con el otro a la altura del codo. 20 segundos por brazo.',
    zone: 'cuello',
    posture: 'sentado o de pie',
    art: fig('desk', 8, [
      {},
      { armL: -82, foreL: -5, armR: -25, foreR: 110 },
      {},
      { armR: 82, foreR: 5, armL: 25, foreL: -110 },
    ]),
  },
  {
    id: 'escapulas',
    title: 'Escápulas juntas',
    text: 'Junta las escápulas como si apretaras un lápiz entre ellas, mantén 5 segundos. 10 veces.',
    zone: 'cuello',
    posture: 'sentado',
    art: fig('chair', 4, [
      { armL: 0, foreL: -90, armR: 0, foreR: -90 },
      { armL: 35, foreL: -90, armR: 35, foreR: -90, torso: -4 },
    ]),
  },

  // Vista
  {
    id: 'cerca-lejos',
    title: 'Cerca y lejos',
    text: 'Mira la punta de tu dedo a 30 cm por 5 segundos y luego algo lejano por 5 segundos. 10 veces.',
    zone: 'vista',
    posture: 'sentado',
    art: { kind: 'eyes', pattern: 'near-far' },
  },
  {
    id: 'palmas-ojos',
    title: 'Palmas sobre los ojos',
    text: 'Frota las manos para calentarlas y cúbrete los ojos cerrados sin apretar. Respira tranquilo 30 segundos.',
    zone: 'vista',
    posture: 'sentado',
    art: { kind: 'eyes', pattern: 'palm' },
  },
  {
    id: 'parpadeo',
    title: 'Parpadeo consciente',
    text: 'Parpadea lento y completo 20 veces, cerrando bien los párpados. Ayuda a no tener los ojos secos.',
    zone: 'vista',
    posture: 'sentado',
    art: { kind: 'eyes', pattern: 'blink' },
  },
  {
    id: 'ojos-ocho',
    title: 'Ojos en ocho',
    text: 'Con la cabeza quieta, dibuja con la mirada un ocho grande acostado, lento. 5 veces en cada sentido.',
    zone: 'vista',
    posture: 'sentado',
    art: { kind: 'eyes', pattern: 'eight' },
  },
  {
    id: 'ojos-cruz',
    title: 'Arriba, abajo, a los lados',
    text: 'Sin mover la cabeza, mira arriba, abajo, izquierda y derecha, 2 segundos en cada punto. 5 vueltas.',
    zone: 'vista',
    posture: 'sentado',
    art: { kind: 'eyes', pattern: 'cross' },
  },
  {
    id: 'ventana',
    title: 'Ventana',
    text: 'Acércate a una ventana y mira el punto más lejano que encuentres durante un minuto.',
    zone: 'vista',
    posture: 'de pie',
    art: { kind: 'eyes', pattern: 'window' },
  },
  {
    id: 'ojos-cerrados',
    title: 'Ojos cerrados',
    text: 'Cierra los ojos, relaja la frente y la mandíbula y quédate así un minuto, sin pantalla.',
    zone: 'vista',
    posture: 'sentado',
    art: { kind: 'eyes', pattern: 'closed' },
  },

  // Manos y muñecas
  {
    id: 'dedos-arriba',
    title: 'Dedos hacia arriba',
    text: 'Brazo estirado con la palma al frente, tira suave de los dedos hacia ti. 15 segundos por mano.',
    zone: 'manos',
    posture: 'sentado',
    art: { kind: 'hand', pattern: 'pull-up' },
  },
  {
    id: 'giros-muneca',
    title: 'Giros de muñeca',
    text: 'Con los puños sueltos, gira las muñecas despacio 10 veces hacia cada lado.',
    zone: 'manos',
    posture: 'sentado',
    art: { kind: 'hand', pattern: 'rotate' },
  },
  {
    id: 'abanico',
    title: 'Abre la mano en abanico',
    text: 'Separa los dedos lo más que puedas, mantén 5 segundos y cierra suave. 10 veces.',
    zone: 'manos',
    posture: 'sentado',
    art: { kind: 'hand', pattern: 'fan' },
  },
  {
    id: 'pulgar-dedos',
    title: 'Pulgar a cada dedo',
    text: 'Toca con el pulgar la punta de cada dedo, ida y vuelta. 5 vueltas por mano.',
    zone: 'manos',
    posture: 'sentado',
    art: { kind: 'hand', pattern: 'thumb' },
  },
  {
    id: 'manos-oracion',
    title: 'Manos en oración',
    text: 'Junta las palmas frente al pecho y baja las manos sin separarlas hasta sentir el estiramiento. 20 segundos.',
    zone: 'manos',
    posture: 'sentado',
    art: fig('desk', 5, [
      { armL: 38, foreL: -128, armR: -38, foreR: 128 },
      { armL: 22, foreL: -95, armR: -22, foreR: 95 },
    ]),
  },
  {
    id: 'sacudir-manos',
    title: 'Sacude las manos',
    text: 'Deja los brazos colgando y sacude las manos sueltas 15 segundos. Descansa y repite 2 veces.',
    zone: 'manos',
    posture: 'de pie',
    art: { kind: 'hand', pattern: 'shake' },
  },
  {
    id: 'antebrazos-mesa',
    title: 'Antebrazos sobre la mesa',
    text: 'Apoya las palmas en el escritorio con los dedos hacia ti y echa el cuerpo atrás suave. 15 segundos.',
    zone: 'manos',
    posture: 'de pie',
    art: fig(
      'side',
      5,
      [
        { torso: 12, armL: -40, armR: -40 },
        { torso: -2, armL: -28, armR: -28, legL: 4, legR: 4 },
      ],
      'table',
    ),
  },

  // Espalda y pecho
  {
    id: 'gato-sentado',
    title: 'Gato sentado',
    text: 'Manos en las rodillas: redondea la espalda mirando al ombligo y luego ábrela sacando pecho. Lento, 8 veces.',
    zone: 'espalda',
    posture: 'sentado',
    art: fig('chair', 5, [
      { armL: -45, foreL: -30, armR: -45, foreR: -30, torso: 22, head: 30 },
      { armL: -25, foreL: -40, armR: -25, foreR: -40, torso: -6, head: -14 },
    ]),
  },
  {
    id: 'giro-silla',
    title: 'Giro en la silla',
    text: 'Sentado derecho, gira el tronco hacia un lado apoyándote en el respaldo. 15 segundos por lado, sin forzar.',
    zone: 'espalda',
    posture: 'sentado',
    art: fig('desk', 8, [
      {},
      { look: -1, armL: 55, foreL: -40, armR: -70, foreR: 50 },
      {},
      { look: 1, armR: -55, foreR: 40, armL: 70, foreL: -50 },
    ]),
  },
  {
    id: 'abrazo-espalda',
    title: 'Abrazo a la espalda',
    text: 'Abrázate llevando las manos a los omóplatos y redondea la espalda alta. Respira hondo 20 segundos.',
    zone: 'espalda',
    posture: 'sentado',
    art: fig('chair', 5, [
      { armL: -70, foreL: -70, armR: -70, foreR: -70 },
      { armL: -80, foreL: -85, armR: -80, foreR: -85, torso: 14, head: 22 },
    ]),
  },
  {
    id: 'brazos-w',
    title: 'Brazos en W',
    text: 'Codos doblados a los lados, llévalos atrás y abajo juntando las escápulas. 3 segundos, 10 veces.',
    zone: 'espalda',
    posture: 'sentado o de pie',
    art: fig('desk', 4, [
      { armL: 95, foreL: 80, armR: -95, foreR: -80 },
      { armL: 55, foreL: 115, armR: -55, foreR: -115, shrug: 2 },
    ]),
  },
  {
    id: 'extension-pie',
    title: 'Extensión de pie',
    text: 'De pie con las manos en la cintura, lleva el pecho hacia arriba y un poco atrás, suave. 5 segundos, 5 veces.',
    zone: 'espalda',
    posture: 'de pie',
    art: fig('side', 5, [
      { armL: 35, foreL: -110, armR: 35, foreR: -110 },
      { armL: 35, foreL: -110, armR: 35, foreR: -110, torso: -12, head: -10 },
    ]),
  },
  {
    id: 'marco-puerta',
    title: 'Marco de la puerta',
    text: 'Apoya los antebrazos en el marco de una puerta y avanza un paso hasta sentir el pecho. 20 segundos.',
    zone: 'espalda',
    posture: 'de pie',
    art: fig(
      'side',
      6,
      [
        { armL: -95, foreL: -80, armR: -95, foreR: -80 },
        { armL: -80, foreL: -95, armR: -80, foreR: -95, torso: 8, legR: -22, shinR: 12, legL: 8 },
      ],
      'door',
    ),
  },

  // Piernas y circulación
  {
    id: 'pies-circulo',
    title: 'Pies en círculo',
    text: 'Levanta un pie y gira el tobillo despacio 10 veces hacia cada lado. Cambia de pie.',
    zone: 'piernas',
    posture: 'sentado',
    art: fig('chair', 3, [
      { ...HANDS_ON_KNEES, shinR: 55, footR: -25 },
      { ...HANDS_ON_KNEES, shinR: 55, footR: 0 },
      { ...HANDS_ON_KNEES, shinR: 55, footR: 25 },
      { ...HANDS_ON_KNEES, shinR: 55, footR: 0 },
    ]),
  },
  {
    id: 'punta-talon',
    title: 'Punta y talón',
    text: 'Sentado, alterna levantar las puntas y los talones de ambos pies. 20 veces.',
    zone: 'piernas',
    posture: 'sentado',
    art: fig('chair', 2.4, [
      { ...HANDS_ON_KNEES, footL: -25, footR: -25 },
      { ...HANDS_ON_KNEES, footL: 30, footR: 30, shinL: 80, shinR: 80 },
    ]),
  },
  {
    id: 'rodilla-estirada',
    title: 'Rodilla estirada',
    text: 'Estira una pierna al frente, mantén 5 segundos con la punta hacia ti y baja. 10 por pierna.',
    zone: 'piernas',
    posture: 'sentado',
    art: fig('chair', 5, [HANDS_ON_KNEES, { ...HANDS_ON_KNEES, shinR: 0, footR: -20 }]),
  },
  {
    id: 'sentarse-pararse',
    title: 'Siéntate y párate',
    text: 'Ponte de pie y vuelve a sentarte despacio, sin usar las manos si puedes. 10 veces.',
    zone: 'piernas',
    posture: 'sentado y de pie',
    art: fig('chair', 5, [
      { armL: -60, armR: -60 },
      { torso: 30, armL: -75, armR: -75, legL: -60, shinL: 70, legR: -60, shinR: 70, y: -6 },
      { legL: 0, shinL: 0, legR: 0, shinR: 0, y: -20, armL: -10, armR: -10 },
    ]),
  },
  {
    id: 'cuadriceps',
    title: 'Cuádriceps de pie',
    text: 'Apoyándote en la mesa, toma un tobillo y lleva el talón hacia el glúteo. 20 segundos por pierna.',
    zone: 'piernas',
    posture: 'de pie',
    art: fig(
      'side',
      5,
      [
        { armL: -50, foreL: -20 },
        { armL: -50, foreL: -20, legR: 12, shinR: 150, armR: 25, foreR: 15 },
      ],
      'table',
    ),
  },
  {
    id: 'pantorrilla-pared',
    title: 'Pantorrilla en la pared',
    text: 'Manos en la pared, una pierna atrás con el talón en el suelo, inclínate hasta sentirla. 20 segundos por lado.',
    zone: 'piernas',
    posture: 'de pie',
    art: fig(
      'side',
      5,
      [
        { armL: -90, foreL: -10, armR: -90, foreR: -10, legR: -10, shinR: 10, legL: 18 },
        { armL: -100, foreL: -20, armR: -100, foreR: -20, torso: 18, legR: -22, shinR: 30, legL: 30, footL: -20 },
      ],
      'wall',
    ),
  },
  {
    id: 'marcha',
    title: 'Marcha en el lugar',
    text: 'Marcha en tu lugar subiendo las rodillas a una altura cómoda durante un minuto.',
    zone: 'piernas',
    posture: 'de pie',
    art: fig('side', 1.6, [
      { legR: -70, shinR: 75, armL: -35, armR: 25 },
      { legL: -70, shinL: 75, armR: -35, armL: 25 },
    ]),
  },

  // Respiración y calma
  {
    id: 'respiracion-cuadrada',
    title: 'Respiración cuadrada',
    text: 'Inhala 4 segundos, mantén 4, exhala 4 y espera 4. 5 vueltas.',
    zone: 'respiracion',
    posture: 'sentado',
    art: breath(['Inhala', 4, 1], ['Mantén', 4, 1], ['Exhala', 4, 0.55], ['Espera', 4, 0.55]),
  },
  {
    id: 'mano-guata',
    title: 'Mano en la guata',
    text: 'Una mano en el pecho y otra en el abdomen: respira para que suba solo la de abajo. 10 respiraciones.',
    zone: 'respiracion',
    posture: 'sentado',
    art: breath(['Sube la guata', 4, 1], ['Baja la guata', 4, 0.55]),
  },
  {
    id: 'suspiro-doble',
    title: 'Suspiro doble',
    text: 'Inhala por la nariz, toma un poquito más de aire arriba y suéltalo largo por la boca. 5 veces.',
    zone: 'respiracion',
    posture: 'sentado',
    art: breath(['Inhala', 3, 0.9], ['Un poco más', 1.5, 1.05], ['Suelta largo', 6, 0.55]),
  },
  {
    id: 'suelta-cara',
    title: 'Suelta la cara',
    text: 'Aprieta los ojos y la mandíbula 5 segundos y suelta todo. Repite 3 veces y nota la diferencia.',
    zone: 'respiracion',
    posture: 'sentado',
    art: breath(['Aprieta', 5, 0.6], ['Suelta', 5, 1]),
  },
  {
    id: 'recorrido-cuerpo',
    title: 'Recorrido del cuerpo',
    text: 'Ojos cerrados, recorre con la atención de los pies a la cabeza y suelta cada zona tensa. Un minuto.',
    zone: 'respiracion',
    posture: 'sentado',
    art: { kind: 'scan' },
  },
  {
    id: 'cinco-cosas',
    title: 'Cinco cosas',
    text: 'Nombra en silencio 5 cosas que ves, 4 que escuchas y 3 que sientes en el cuerpo.',
    zone: 'respiracion',
    posture: 'sentado',
    art: breath(['5 que ves', 4, 1], ['4 que escuchas', 4, 0.85], ['3 que sientes', 4, 0.7]),
  },
  {
    id: 'exhalacion-larga',
    title: 'Exhalación larga',
    text: 'Inhala en 4 y exhala lento en 8, como soplando por una bombilla. 6 veces.',
    zone: 'respiracion',
    posture: 'sentado',
    art: breath(['Inhala', 4, 1], ['Exhala lento', 8, 0.55]),
  },

  // Movilidad de pie y caminar
  {
    id: 'escaleras',
    title: 'Escaleras',
    text: 'Si hay escaleras cerca, sube y baja un piso a tu ritmo, afirmado de la baranda.',
    zone: 'movilidad',
    posture: 'de pie',
    art: fig('side', 2, [{ legR: -55, shinR: 55, armL: -25, armR: 20 }, { legL: -55, shinL: 55, armR: -25, armL: 20 }], 'stairs'),
  },
  {
    id: 'brazos-circulo',
    title: 'Brazos en círculo',
    text: 'Brazos estirados a los lados, haz círculos pequeños que crecen. 10 hacia adelante y 10 hacia atrás.',
    zone: 'movilidad',
    posture: 'de pie',
    art: fig('front', 2, [
      { armL: 80, armR: -80 },
      { armL: 90, armR: -90, shrug: -2 },
      { armL: 100, armR: -100 },
      { armL: 90, armR: -90, shrug: 2 },
    ]),
  },
  {
    id: 'caderas-circulo',
    title: 'Caderas en círculo',
    text: 'Manos en la cintura, dibuja círculos amplios con la cadera. 8 hacia cada lado.',
    zone: 'movilidad',
    posture: 'de pie',
    art: fig('front', 4, [
      { ...HANDS_ON_WAIST, torso: -8 },
      { ...HANDS_ON_WAIST, y: 2 },
      { ...HANDS_ON_WAIST, torso: 8 },
      { ...HANDS_ON_WAIST, y: -1 },
    ]),
  },
  {
    id: 'balanceo-brazos',
    title: 'Balanceo de brazos',
    text: 'Gira el tronco suave de lado a lado dejando que los brazos se balanceen sueltos. 30 segundos.',
    zone: 'movilidad',
    posture: 'de pie',
    art: fig('front', 2.4, [
      { look: -1, armL: 60, foreL: 20, armR: 30, foreR: 60 },
      { look: 1, armR: -60, foreR: -20, armL: -30, foreL: -60 },
    ]),
  },
  {
    id: 'equilibrio',
    title: 'Equilibrio en un pie',
    text: 'Apoyado en la mesa, párate en un pie 20 segundos y cambia. Si puedes, suéltate un poco.',
    zone: 'movilidad',
    posture: 'de pie',
    art: fig(
      'side',
      4,
      [
        { armR: -50, foreR: -20, legL: 20, shinL: 80 },
        { armR: -35, foreR: -10, legL: 22, shinL: 85, torso: 2 },
      ],
      'table',
    ),
  },
  {
    id: 'alcanza-cielo',
    title: 'Alcanza el cielo',
    text: 'Estira un brazo arriba como si tomaras algo de una repisa alta, alternando. 10 por lado.',
    zone: 'movilidad',
    posture: 'de pie',
    art: fig('front', 3, [
      { armL: 172, armR: -15, torso: 4 },
      { armR: -172, armL: 15, torso: -4 },
    ]),
  },
  {
    id: 'recado-a-pie',
    title: 'Recado a pie',
    text: 'En vez de mandar un mensaje, ve a hablar con alguien en persona o llena tu botella de agua.',
    zone: 'movilidad',
    posture: 'de pie',
    art: fig('side', 1.4, [
      { ...WALK_A, armR: -40, foreR: -70 },
      { ...WALK_B, armR: -40, foreR: -70 },
    ]),
  },
];
