/**
 * National holidays of Chile ("feriados nacionales"), 2026 and 2027, as
 * `YYYY-MM-DD` dates (spec 2026-09-30-horarios.md). The portal offers them
 * when the admin creates the schedule; the admin can add or remove dates.
 *
 * Sources (checked 2026-09-30):
 * - Laws: Ley 2.977 (base list), Ley 19.668 (June 29 and October 12 move to
 *   a Monday), Ley 19.973 (irrenunciables), Ley 20.148 (Virgen del Carmen),
 *   Ley 20.299 (Iglesias Evangélicas), Ley 20.983 (September 17 when
 *   September 18–19 fall on Saturday–Sunday), Ley 21.357 (Pueblos Indígenas:
 *   day of the winter solstice).
 * - Official calendar 2026: gob.cl, "¿Qué feriados hay en 2026?"
 *   (https://www.gob.cl/noticias/feriados-2026-revisa-cuantos-habra-y-cuales-son-irrenunciables/).
 * - Calendar 2027: https://www.feriados.cl/2027.php (same laws; no official
 *   gob.cl note for 2027 yet).
 *
 * Not included: regional holidays (June 7 in Arica y Parinacota, August 20 in
 * Chillán and Chillán Viejo), December 31 (banks only), and election days
 * (none scheduled for 2026–2027 when this list was written). Sundays are not
 * listed: the week schedule decides whether Sunday is a working day.
 */

export interface ChileHoliday {
  date: string;
  name: string;
}

export const CHILE_HOLIDAYS: readonly ChileHoliday[] = Object.freeze([
  // 2026 (16)
  { date: '2026-01-01', name: 'Año Nuevo' },
  { date: '2026-04-03', name: 'Viernes Santo' },
  { date: '2026-04-04', name: 'Sábado Santo' },
  { date: '2026-05-01', name: 'Día Nacional del Trabajo' },
  { date: '2026-05-21', name: 'Día de las Glorias Navales' },
  { date: '2026-06-21', name: 'Día Nacional de los Pueblos Indígenas' },
  { date: '2026-06-29', name: 'San Pedro y San Pablo' },
  { date: '2026-07-16', name: 'Día de la Virgen del Carmen' },
  { date: '2026-08-15', name: 'Asunción de la Virgen' },
  { date: '2026-09-18', name: 'Independencia Nacional' },
  { date: '2026-09-19', name: 'Día de las Glorias del Ejército' },
  { date: '2026-10-12', name: 'Encuentro de Dos Mundos' },
  { date: '2026-10-31', name: 'Día de las Iglesias Evangélicas y Protestantes' },
  { date: '2026-11-01', name: 'Día de Todos los Santos' },
  { date: '2026-12-08', name: 'Inmaculada Concepción' },
  { date: '2026-12-25', name: 'Navidad' },
  // 2027 (17)
  { date: '2027-01-01', name: 'Año Nuevo' },
  { date: '2027-03-26', name: 'Viernes Santo' },
  { date: '2027-03-27', name: 'Sábado Santo' },
  { date: '2027-05-01', name: 'Día Nacional del Trabajo' },
  { date: '2027-05-21', name: 'Día de las Glorias Navales' },
  { date: '2027-06-21', name: 'Día Nacional de los Pueblos Indígenas' },
  // June 29 is a Tuesday: moved to Monday 28 (Ley 19.668).
  { date: '2027-06-28', name: 'San Pedro y San Pablo' },
  { date: '2027-07-16', name: 'Día de la Virgen del Carmen' },
  { date: '2027-08-15', name: 'Asunción de la Virgen' },
  // September 18–19 fall on Saturday–Sunday: Friday 17 is a holiday (Ley 20.983).
  { date: '2027-09-17', name: 'Feriado adicional de Fiestas Patrias' },
  { date: '2027-09-18', name: 'Independencia Nacional' },
  { date: '2027-09-19', name: 'Día de las Glorias del Ejército' },
  // October 12 is a Tuesday: moved to Monday 11 (Ley 19.668).
  { date: '2027-10-11', name: 'Encuentro de Dos Mundos' },
  { date: '2027-10-31', name: 'Día de las Iglesias Evangélicas y Protestantes' },
  { date: '2027-11-01', name: 'Día de Todos los Santos' },
  { date: '2027-12-08', name: 'Inmaculada Concepción' },
  { date: '2027-12-25', name: 'Navidad' },
].map((h) => Object.freeze(h)));

/** Dates of `CHILE_HOLIDAYS`, sorted (33 entries: fits in the 60 allowed). */
export const CHILE_HOLIDAY_DATES: readonly string[] = Object.freeze(CHILE_HOLIDAYS.map((h) => h.date));

/** Name of a Chilean national holiday on `date`, or null. */
export function chileHolidayName(date: string): string | null {
  return CHILE_HOLIDAYS.find((h) => h.date === date)?.name ?? null;
}
