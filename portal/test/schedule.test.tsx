/**
 * Working hours in the portal (spec 2026-09-30-horarios.md, Tarea 3):
 * editor (validation, shortcuts, holidays, exact payload), per-person
 * exception, Equipo columns and CSV, timeline shading and the day cards.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHILE_HOLIDAY_DATES,
  planForDay,
  secondsToHours,
  teamSummaryToCsv,
  type PersonSchedule,
  type ScheduleConfig,
} from '@timetracking/shared';
import { App } from '../src/App';
import { Timeline } from '../src/components/Timeline';
import { BackendProvider } from '../src/data/context';
import type { Backend } from '../src/data/types';
import { dayBounds } from '../src/lib/dates';
import {
  DEFAULT_WEEK,
  addChileHolidays,
  addHoliday,
  buildPersonSchedule,
  buildScheduleConfig,
  complianceCsvExtra,
  copyMondayToWeekdays,
  defaultScheduleForm,
  describeWeek,
  holidayLabel,
  removePastHolidays,
  teamCompliance,
  validateScheduleForm,
  weekToForm,
} from '../src/lib/schedule';
import { buildTeam } from '../src/lib/team';
import { buildTimeline } from '../src/lib/timeline';
import { ADMIN, backendOf, emptyDb, member, slot, type FakeDb } from './fakes';

const M = 60_000;
// 2026-09-29 (Tuesday) 15:30 in Santiago.
const NOW = Date.UTC(2026, 8, 29, 18, 30);
const day = dayBounds('2026-09-29');
const at = (h: number, m = 0): number => day.from + h * 60 * M + m * M;

function renderApp(backend: Backend, path = '/') {
  return render(
    <BackendProvider backend={backend}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </BackendProvider>,
  );
}

function general(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    week: DEFAULT_WEEK,
    holidays: [...CHILE_HOLIDAY_DATES],
    toleranceMinutes: 5,
    remindersEnabled: true,
    updatedAt: NOW - 86_400_000,
    updatedBy: 'otro-admin',
    ...overrides,
  };
}

/** Beto: Tuesday 09:30–12:00 without lunch (arrives 10:00 → 30 min late, leaves 11:00 → 1 h early). */
const BETO_EXCEPTION: PersonSchedule = {
  week: { ...DEFAULT_WEEK, tue: { start: '09:30', end: '12:00', lunchStart: null, lunchEnd: null } },
  updatedAt: NOW - 3_600_000,
  updatedBy: ADMIN.id,
};

function db(withSchedule = true): FakeDb {
  const d = emptyDb();
  d.config = {
    allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
    screenshotsEnabled: true,
    blurScreenshots: true,
    screenshotRetentionDays: 90,
    updatedAt: NOW - 3_600_000,
    updatedBy: 'system',
  };
  d.users = [ADMIN, member('ana', 'Ana Rojas'), member('beto', 'Beto Díaz')];
  d.activity = [slot('ana', at(9), 600, 540), slot('ana', at(9, 10), 600, 300), slot('beto', at(10), 300, 60)];
  d.sessions = [
    { id: 's-ana', uid: 'ana', startedAt: at(9), endedAt: null, endReason: null, lastHeartbeatAt: NOW - 2 * M },
    { id: 's-beto', uid: 'beto', startedAt: at(10), endedAt: at(11), endReason: 'manual', lastHeartbeatAt: at(11) },
  ];
  if (withSchedule) {
    d.schedule = general();
    d.schedules = { beto: BETO_EXCEPTION };
  }
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------- pure helpers ----------

describe('schedule form helpers', () => {
  it('the suggested schedule: L–J 09:00–18:30 with lunch, V 09:00–14:00, weekend off, Chilean holidays, 5 min, reminders', () => {
    const doc = buildScheduleConfig(defaultScheduleForm(), 'admin-1', NOW + 0.7);
    expect(doc).toEqual({
      week: {
        mon: { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' },
        tue: { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' },
        wed: { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' },
        thu: { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' },
        fri: { start: '09:00', end: '14:00', lunchStart: null, lunchEnd: null },
        sat: null,
        sun: null,
      },
      holidays: [...CHILE_HOLIDAY_DATES].sort(),
      toleranceMinutes: 5,
      remindersEnabled: true,
      updatedAt: NOW,
      updatedBy: 'admin-1',
    });
    expect(Object.keys(doc).sort()).toEqual(['holidays', 'remindersEnabled', 'toleranceMinutes', 'updatedAt', 'updatedBy', 'week']);
  });

  it('validates with the shared messages and refuses to build an invalid document', () => {
    const form = defaultScheduleForm();
    form.week.mon = { ...form.week.mon, end: '08:00' };
    form.week.tue = { ...form.week.tue, lunchStart: '19:00', lunchEnd: '20:00', end: '18:30' };
    form.week.wed = { ...form.week.wed, start: '' };
    form.toleranceMinutes = '61';
    const messages = validateScheduleForm(form).map((i) => i.message);
    expect(messages).toContain('Lunes: la salida debe ser posterior a la entrada (sin cruzar la medianoche).');
    expect(messages).toContain('Martes: la colación debe quedar dentro del horario (09:00–18:30).');
    expect(messages).toContain('Miércoles: la hora de entrada debe tener formato HH:MM (24 h).');
    expect(messages).toContain('La tolerancia debe ser un número entero de minutos entre 0 y 60.');
    expect(() => buildScheduleConfig(form, 'a', NOW)).toThrow();
    // A day off or a day without lunch keeps its typed times but writes null.
    const off = defaultScheduleForm();
    off.week.mon = { ...off.week.mon, enabled: false };
    off.week.tue = { ...off.week.tue, lunch: false };
    const doc = buildScheduleConfig(off, 'a', NOW);
    expect(doc.week.mon).toBeNull();
    expect(doc.week.tue).toEqual({ start: '09:00', end: '18:30', lunchStart: null, lunchEnd: null });
  });

  it('copies Monday to Tuesday–Friday (not to the weekend)', () => {
    const week = weekToForm(DEFAULT_WEEK);
    week.mon = { ...week.mon, start: '08:30' };
    const copied = copyMondayToWeekdays(week);
    for (const wd of ['tue', 'wed', 'thu', 'fri'] as const) expect(copied[wd]).toEqual(copied.mon);
    expect(copied.sat.enabled).toBe(false);
    expect(copied.fri).not.toBe(copied.mon);
  });

  it('holidays: add, duplicates, the 60 cap, Chilean ones and past ones', () => {
    expect(addHoliday(['2026-12-25'], '2026-12-31')).toEqual({ ok: true, holidays: ['2026-12-25', '2026-12-31'] });
    expect(addHoliday(['2026-12-25'], '2026-12-25')).toEqual({ ok: false, error: 'El 25-12-2026 ya está en la lista.' });
    expect(addHoliday([], '2026-02-30')).toEqual({ ok: false, error: 'La fecha no es válida.' });
    expect(addHoliday([], '')).toEqual({ ok: false, error: 'Elige la fecha del feriado.' });
    const sixty = Array.from({ length: 60 }, (_, i) => `2030-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`);
    expect(addHoliday(sixty, '2031-01-01')).toMatchObject({ ok: false, error: expect.stringContaining('hasta 60') });
    const chile = addChileHolidays(['2026-12-25', '2027-12-31']);
    expect(chile.added).toBe(CHILE_HOLIDAY_DATES.length - 1);
    expect(chile.holidays).toContain('2027-12-31');
    expect(addChileHolidays(chile.holidays).added).toBe(0);
    expect(removePastHolidays(['2026-01-01', '2026-09-29', '2027-01-01'], '2026-09-29')).toEqual({
      holidays: ['2026-09-29', '2027-01-01'],
      removed: 1,
    });
    expect(holidayLabel('2026-09-18')).toEqual({ date: '2026-09-18', label: 'vie 18-09-2026', name: 'Independencia Nacional' });
    expect(holidayLabel('2027-12-31').name).toBeNull();
  });

  it('describes a week grouping equal days', () => {
    expect(describeWeek(DEFAULT_WEEK)).toEqual([
      'Lunes a jueves: 09:00–18:30, colación 13:00–14:00',
      'Viernes: 09:00–14:00, sin colación',
      'Sábado y domingo: libre',
    ]);
  });

  it('per-person document: the 3 fields', () => {
    expect(buildPersonSchedule(weekToForm(DEFAULT_WEEK), 'admin-1', NOW)).toEqual({ week: DEFAULT_WEEK, updatedAt: NOW, updatedBy: 'admin-1' });
  });
});

// ---------- Configuración → Horario ----------

describe('Configuración → Horario', () => {
  it('without a schedule: explains it, creates one from the suggested values, validates live and writes the exact document', async () => {
    const data = db(false);
    const backend = backendOf(data, ADMIN);
    renderApp(backend, '/configuracion');
    const section = await screen.findByRole('region', { name: 'Horario' });
    expect(await within(section).findByText('Sin horario configurado')).toBeInTheDocument();
    expect(section).toHaveTextContent('mide siempre que la jornada esté abierta');
    await userEvent.click(within(section).getByRole('button', { name: 'Crear horario' }));

    // Suggested values, shown before saving.
    expect(within(section).getByText(/Estos son valores sugeridos/)).toBeInTheDocument();
    expect(screen.getByLabelText('Entrada (Lunes)')).toHaveValue('09:00');
    expect(screen.getByLabelText('Salida (Lunes)')).toHaveValue('18:30');
    expect(screen.getByLabelText('Desde (colación del lunes)')).toHaveValue('13:00');
    expect(screen.getByLabelText('Salida (Viernes)')).toHaveValue('14:00');
    expect(screen.getByLabelText('Colación (Viernes)')).not.toBeChecked();
    expect(screen.getByLabelText('Sábado: día laboral')).not.toBeChecked();
    expect(within(screen.getByTestId('day-sat')).getByText('Libre')).toBeInTheDocument();
    expect(screen.getByLabelText('Tolerancia (minutos)')).toHaveValue(5);
    expect(screen.getByLabelText(/Recordatorios/)).toBeChecked();
    const list = screen.getByRole('list', { name: 'Feriados' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(CHILE_HOLIDAY_DATES.length);
    expect(list).toHaveTextContent('vie 18-09-2026Independencia Nacional · pasado');

    // Live validation with the shared messages.
    fireEvent.change(screen.getByLabelText('Salida (Lunes)'), { target: { value: '08:00' } });
    expect(within(screen.getByTestId('day-mon')).getByRole('alert')).toHaveTextContent(
      'Lunes: la salida debe ser posterior a la entrada (sin cruzar la medianoche).',
    );
    expect(screen.getByLabelText('Salida (Lunes)')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('Salida (Lunes)'), { target: { value: '18:30' } });
    expect(within(screen.getByTestId('day-mon')).queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Hasta (colación del lunes)'), { target: { value: '19:00' } });
    expect(within(screen.getByTestId('day-mon')).getByRole('alert')).toHaveTextContent(
      'Lunes: la colación debe quedar dentro del horario (09:00–18:30).',
    );
    fireEvent.change(screen.getByLabelText('Hasta (colación del lunes)'), { target: { value: '14:00' } });
    const tolerance = screen.getByLabelText('Tolerancia (minutos)');
    await userEvent.clear(tolerance);
    await userEvent.type(tolerance, '61');
    expect(screen.getByText('La tolerancia debe ser un número entero de minutos entre 0 y 60.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Guardar y activar horario' }));
    expect(screen.getByText('Corrige los problemas marcados antes de guardar.')).toBeInTheDocument();
    expect(backend.data.saveScheduleConfig).not.toHaveBeenCalled();
    await userEvent.clear(tolerance);
    await userEvent.type(tolerance, '10');

    // Shortcut: Monday (08:30) to Tuesday–Friday (Friday gets the lunch too).
    fireEvent.change(screen.getByLabelText('Entrada (Lunes)'), { target: { value: '08:30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Copiar lunes a martes–viernes' }));
    expect(screen.getByLabelText('Entrada (Viernes)')).toHaveValue('08:30');
    expect(screen.getByLabelText('Salida (Viernes)')).toHaveValue('18:30');
    expect(screen.getByLabelText('Colación (Viernes)')).toBeChecked();
    // Saturday on and off again (keeps its default times while on).
    await userEvent.click(screen.getByLabelText('Sábado: día laboral'));
    expect(screen.getByLabelText('Entrada (Sábado)')).toHaveValue('09:00');
    await userEvent.click(screen.getByLabelText('Sábado: día laboral'));
    await userEvent.click(screen.getByLabelText(/Recordatorios/));

    // Holidays: remove one, add a date (and a repeated one), bring the Chilean ones back.
    await userEvent.click(screen.getByRole('button', { name: 'Quitar feriado jue 01-01-2026 (Año Nuevo)' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(CHILE_HOLIDAY_DATES.length - 1);
    const add = screen.getByLabelText('Agregar feriado');
    fireEvent.change(add, { target: { value: '2027-12-31' } });
    await userEvent.click(screen.getByRole('button', { name: 'Agregar fecha' }));
    expect(list).toHaveTextContent('vie 31-12-2027Feriado agregado');
    fireEvent.change(add, { target: { value: '2027-12-31' } });
    await userEvent.click(screen.getByRole('button', { name: 'Agregar fecha' }));
    expect(screen.getByText('El 31-12-2027 ya está en la lista.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Agregar feriados de Chile 2026–2027' }));
    expect(screen.getByText('Se agregó 1 feriado de Chile 2026–2027.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quitar feriados pasados (11)' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Guardar y activar horario' }));
    await waitFor(() => expect(data.schedule).not.toBeNull());
    const lj = { start: '08:30', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' };
    expect(data.schedule).toEqual({
      week: { mon: lj, tue: lj, wed: lj, thu: lj, fri: lj, sat: null, sun: null },
      holidays: [...CHILE_HOLIDAY_DATES, '2027-12-31'].sort(),
      toleranceMinutes: 10,
      remindersEnabled: false,
      updatedAt: NOW,
      updatedBy: ADMIN.id,
    });
    expect(await screen.findByText('Horario creado. La extensión lo aplica en unos minutos.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Guardar horario' })).toBeInTheDocument();
  });

  it('edits the saved schedule and deletes it after confirming', async () => {
    const data = db(true);
    const backend = backendOf(data, ADMIN);
    renderApp(backend, '/configuracion');
    const tolerance = await screen.findByLabelText('Tolerancia (minutos)');
    expect(screen.getByText(/Última modificación ayer/)).toBeInTheDocument();
    await userEvent.clear(tolerance);
    await userEvent.type(tolerance, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar horario' }));
    await waitFor(() => expect(data.schedule?.toleranceMinutes).toBe(0));
    expect(data.schedule).toEqual({ ...general(), toleranceMinutes: 0, updatedAt: NOW, updatedBy: ADMIN.id });
    expect(await screen.findByText('Horario guardado. La extensión lo aplica en unos minutos.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Eliminar horario' }));
    const dialog = screen.getByRole('dialog', { name: 'Eliminar horario' });
    expect(dialog).toHaveTextContent('sin horario');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(backend.data.deleteScheduleConfig).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar horario' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar horario' }));
    await waitFor(() => expect(data.schedule).toBeNull());
    expect(await screen.findByText('Sin horario configurado')).toBeInTheDocument();
    expect(screen.getByText(/Horario eliminado/)).toBeInTheDocument();
    // The organization settings form is still there and unaffected.
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeInTheDocument();
  });
});

// ---------- Colaboradores: exception ----------

describe('Colaboradores → horario personalizado', () => {
  it('personalizes a person (exact document) and goes back to the general schedule', async () => {
    const data = db(true);
    const backend = backendOf(data, ADMIN);
    renderApp(backend, '/colaboradores');
    const item = () => screen.getAllByRole('listitem').find((li) => li.textContent?.includes('Ana Rojas'))!;
    await screen.findByText('Ana Rojas');
    expect(item()).toHaveTextContent('Horario: General');
    const betoItem = screen.getAllByRole('listitem').find((li) => li.textContent?.includes('Beto Díaz'))!;
    expect(betoItem).toHaveTextContent('Horario: Personalizado');

    const toggle = within(item()).getByRole('button', { name: 'Editar horario de Ana Rojas' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    const panel = screen.getByRole('region', { name: 'Horario de Ana Rojas' });
    expect(panel).toHaveTextContent('Usa el horario general:');
    expect(panel).toHaveTextContent('Lunes a jueves: 09:00–18:30, colación 13:00–14:00');
    await userEvent.click(within(panel).getByRole('button', { name: 'Personalizar horario' }));
    // Starts from the general week.
    expect(within(panel).getByLabelText('Entrada (Lunes)')).toHaveValue('09:00');
    fireEvent.change(within(panel).getByLabelText('Entrada (Lunes)'), { target: { value: '08:00' } });
    fireEvent.change(within(panel).getByLabelText('Salida (Lunes)'), { target: { value: '07:00' } });
    expect(within(panel).getByRole('alert')).toHaveTextContent('Lunes: la salida debe ser posterior a la entrada');
    await userEvent.click(within(panel).getByRole('button', { name: 'Guardar horario personalizado' }));
    expect(backend.data.savePersonSchedule).not.toHaveBeenCalled();
    fireEvent.change(within(panel).getByLabelText('Salida (Lunes)'), { target: { value: '17:00' } });
    await userEvent.click(within(panel).getByRole('button', { name: 'Guardar horario personalizado' }));
    await waitFor(() => expect(data.schedules.ana).toBeDefined());
    expect(data.schedules.ana).toEqual({
      week: { ...DEFAULT_WEEK, mon: { start: '08:00', end: '17:00', lunchStart: '13:00', lunchEnd: '14:00' } },
      updatedAt: NOW,
      updatedBy: ADMIN.id,
    });
    expect(await within(panel).findByText('Horario personalizado de Ana Rojas guardado.')).toBeInTheDocument();
    await waitFor(() => expect(item()).toHaveTextContent('Horario: Personalizado'));

    await userEvent.click(within(panel).getByRole('button', { name: 'Volver al general' }));
    const dialog = screen.getByRole('dialog', { name: 'Volver al horario general' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Volver al general' }));
    await waitFor(() => expect(data.schedules.ana).toBeUndefined());
    expect(backend.data.deletePersonSchedule).toHaveBeenCalledWith('ana');
    expect(await screen.findByText('Ana Rojas vuelve a usar el horario general.')).toBeInTheDocument();
    await waitFor(() => expect(item()).toHaveTextContent('Horario: General'));
  });

  it('without a general schedule: allows the exception but warns about holidays and reminders', async () => {
    const data = db(false);
    renderApp(backendOf(data, ADMIN), '/colaboradores');
    await screen.findByText('Beto Díaz');
    const beto = screen.getAllByRole('listitem').find((li) => li.textContent?.includes('Beto Díaz'))!;
    expect(beto).toHaveTextContent('Horario: Sin horario');
    await userEvent.click(within(beto).getByRole('button', { name: 'Editar horario de Beto Díaz' }));
    const panel = screen.getByRole('region', { name: 'Horario de Beto Díaz' });
    expect(panel).toHaveTextContent('Sin horario: no hay horario general.');
    await userEvent.click(within(panel).getByRole('button', { name: 'Personalizar horario' }));
    expect(panel).toHaveTextContent(
      'La organización no tiene horario general. Beto Díaz tendrá solo este horario, sin feriados ni recordatorios',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Guardar horario personalizado' }));
    await waitFor(() => expect(data.schedules.beto).toEqual({ week: DEFAULT_WEEK, updatedAt: NOW, updatedBy: ADMIN.id }));
  });
});

// ---------- Equipo ----------

describe('Equipo: columnas de horario', () => {
  const cellsOf = (table: HTMLElement, text: string) => {
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent ?? '');
    const row = within(table).getAllByRole('row').find((r) => r.textContent?.includes(text))!;
    const cells = [...row.querySelectorAll('td, th')].map((c) => c.textContent ?? '');
    return (h: string) => cells[headers.indexOf(h)];
  };

  it('shows expected, in schedule, outside, lateness, offline and absences, with totals, and the CSV agrees', async () => {
    const data = db(true);
    const backend = backendOf(data, ADMIN);
    renderApp(backend);
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Esperadas', 'En horario', 'Fuera de horario', 'Atrasos', 'Sin conexión en horario', 'Ausencias']));
    // The schedule is read once (config + every exception), not per person.
    expect(backend.data.getScheduleConfig).toHaveBeenCalledTimes(1);
    expect(backend.data.listPersonSchedules).toHaveBeenCalledTimes(1);
    expect(backend.data.getPersonSchedule).not.toHaveBeenCalled();

    // Ana (general): 09:00 → 15:28, lunch 13–14. Expected so far 4 h + 1 h 30.
    const ana = cellsOf(table, 'Ana Rojas');
    expect(ana('Esperadas')).toBe('5 h 30 minde 8 h 30 min');
    expect(ana('En horario')).toBe('5 h 28 min');
    expect(ana('Fuera de horario')).toBe('0 min');
    expect(ana('Atrasos')).toBe('0');
    expect(ana('Sin conexión en horario')).toBe('2 min');
    expect(ana('Ausencias')).toBe('0');
    // Beto (personalized 09:30–12:00): arrives 10:00, leaves 11:00.
    const beto = cellsOf(table, 'Beto Díaz');
    expect(beto('Esperadas')).toBe('2 h 30 minpersonalizado');
    expect(beto('En horario')).toBe('1 h 00 min');
    expect(beto('Atrasos')).toBe('130 min');
    expect(beto('Sin conexión en horario')).toBe('1 h 30 min');
    // Totals: + the admin (general, no session).
    const total = cellsOf(table, 'Total (');
    expect(total('Esperadas')).toBe('13 h 30 minde 19 h 30 min');
    expect(total('En horario')).toBe('6 h 28 min');
    expect(total('Atrasos')).toBe('130 min');
    expect(total('Sin conexión en horario')).toBe('7 h 02 min');
    expect(total('Ausencias')).toBe('0');

    // CSV: same figures (decimal hours).
    const [users, slots, sessions] = await Promise.all([backend.data.listUsers(), backend.data.listActivity(day), backend.data.listSessions(day)]);
    const team = buildTeam(users, slots, sessions, day, NOW);
    const tc = teamCompliance(team.rows.map((r) => r.uid), sessions, { config: data.schedule, persons: new Map(Object.entries(data.schedules)) }, '2026-09-29', '2026-09-29', NOW)!;
    const csv = teamSummaryToCsv(team, { separator: ';', decimalSeparator: ',', extra: complianceCsvExtra(tc) });
    const [head, ...lines] = csv.trim().split(/\r\n/);
    const cols = head!.split(';');
    expect(cols.slice(-9)).toEqual([
      'Horario',
      'Horas esperadas',
      'Horas esperadas a la fecha',
      'Horas en horario',
      'Horas fuera de horario',
      'Atrasos',
      'Horas de atraso',
      'Horas sin conexión en horario',
      'Ausencias (días)',
    ]);
    const csvOf = (name: string, col: string) => lines.find((l) => l.startsWith(name))!.split(';')[cols.indexOf(col)];
    const dec = (s: number) => String(secondsToHours(s)).replace('.', ',');
    expect(csvOf('Ana Rojas', 'Horario')).toBe('General');
    expect(csvOf('Ana Rojas', 'Horas esperadas')).toBe('8,5');
    expect(csvOf('Ana Rojas', 'Horas esperadas a la fecha')).toBe('5,5');
    expect(csvOf('Ana Rojas', 'Horas en horario')).toBe(dec(5 * 3600 + 28 * 60));
    expect(csvOf('Ana Rojas', 'Horas sin conexión en horario')).toBe(dec(120));
    expect(csvOf('Beto Díaz', 'Horario')).toBe('Personalizado');
    expect(csvOf('Beto Díaz', 'Atrasos')).toBe('1');
    expect(csvOf('Beto Díaz', 'Horas de atraso')).toBe('0,5');
    expect(csvOf('Beto Díaz', 'Ausencias (días)')).toBe('0');
  });

  it('the page exports the CSV with the schedule columns', async () => {
    const created: Blob[] = [];
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = (b: Blob | MediaSource) => {
      created.push(b as Blob);
      return 'blob:x';
    };
    URL.revokeObjectURL = () => undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderApp(backendOf(db(true), ADMIN));
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    const text = await created[0]!.text();
    expect(text).toContain(';Horario;Horas esperadas;Horas esperadas a la fecha;Horas en horario;');
    expect(text).toMatch(/Beto Díaz;[^\r]*;Personalizado;2,5;2,5;1;0;1;0,5;1,5;0\r\n/);
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
    click.mockRestore();
  });

  it('without any schedule the columns are not shown', async () => {
    renderApp(backendOf(db(false), ADMIN));
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('Esperadas');
    expect(headers).not.toContain('Atrasos');
  });

  it('only an exception (no general schedule): columns, "Sin horario" for the others', async () => {
    const data = db(false);
    data.schedules = { beto: BETO_EXCEPTION };
    renderApp(backendOf(data, ADMIN));
    const table = await screen.findByRole('table');
    const ana = cellsOf(table, 'Ana Rojas');
    expect(ana('Esperadas')).toBe('Sin horario');
    expect(ana('Atrasos')).toBe('—');
    expect(cellsOf(table, 'Beto Díaz')('Atrasos')).toBe('130 min');
  });
});

// ---------- timeline ----------

describe('Timeline con horario', () => {
  const plan = planForDay('2026-09-29', DEFAULT_WEEK, []);

  it('shades outside the schedule and the lunch, marks entry and exit, and includes the scheduled hours', async () => {
    const t = buildTimeline(day.from, day.to, [slot('ana', at(8, 50), 600, 540), slot('ana', at(9), 600, 540)], [], { plan });
    // 08:00 (data at 08:50) … 18:00 (exit at 18:30).
    expect(t.rows.map((r) => r.hourLabel)).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
    render(<Timeline timeline={t} />);
    const cell = (label: string) => screen.getAllByTestId('timeline-cell').find((c) => c.getAttribute('aria-label')?.startsWith(label))!;
    expect(cell('08:00')).toHaveClass('lvl-none', 'sch-off');
    expect(cell('08:00')).toHaveAccessibleName('08:00–08:10: sin datos, fuera de horario');
    // Data outside the schedule keeps its activity color, with the band.
    expect(cell('08:50')).toHaveClass('lvl-high', 'sch-off');
    expect(cell('09:00')).not.toHaveClass('sch-off');
    expect(cell('09:00')).toHaveAccessibleName(
      '09:00–09:10: 90 % de actividad, medido 10 min, sitios: mail.google.com, entrada programada a las 09:00',
    );
    expect(cell('09:00').querySelector('.sch-mark-start')).not.toBeNull();
    expect(cell('13:00')).toHaveClass('sch-lunch');
    expect(cell('13:50')).toHaveAccessibleName('13:50–14:00: sin datos, en colación');
    expect(cell('14:00')).not.toHaveClass('sch-lunch');
    expect(cell('18:20')).toHaveAccessibleName('18:20–18:30: sin datos, salida programada a las 18:30');
    expect(cell('18:20').querySelector('.sch-mark-end')).not.toBeNull();
    expect(cell('18:30')).toHaveClass('sch-off');

    await userEvent.hover(cell('13:00'));
    expect(screen.getByTestId('timeline-detail')).toHaveTextContent('Colación');
    await userEvent.hover(cell('09:00'));
    expect(screen.getByTestId('timeline-detail')).toHaveTextContent('Entrada programada 09:00');
    const legend = screen.getByRole('list', { name: 'Leyenda' });
    expect(legend).toHaveTextContent('Fuera de horario');
    expect(legend).toHaveTextContent('Colación');
    expect(legend).toHaveTextContent('Entrada o salida programada');
  });

  it('an entry at 08:45 marks three quarters into its block; a holiday is all outside', () => {
    const week = { ...DEFAULT_WEEK, tue: { start: '08:45', end: '12:00', lunchStart: null, lunchEnd: null } };
    const t = buildTimeline(day.from, day.to, [], [], { plan: planForDay('2026-09-29', week, []) });
    const b840 = t.rows.flatMap((r) => r.blocks).find((b) => b.label === '08:40')!;
    expect(b840.marks).toEqual([{ kind: 'start', at: 0.5, time: '08:45' }]);
    expect(b840.schedule).toBe('work'); // 5 of 10 minutes: ties go to work
    const holiday = buildTimeline(day.from, day.to, [slot('ana', at(10))], [], { plan: planForDay('2026-09-29', DEFAULT_WEEK, ['2026-09-29']) });
    expect(holiday.rows.flatMap((r) => r.blocks).every((b) => b.schedule === 'off' && b.marks.length === 0)).toBe(true);
    expect(holiday.rows.map((r) => r.hourLabel)).toEqual(['10:00']);
  });

  it('without a schedule nothing changes', () => {
    const t = buildTimeline(day.from, day.to, [slot('ana', at(9))]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.blocks.every((b) => b.schedule === null && b.marks.length === 0)).toBe(true);
  });
});

// ---------- detail cards ----------

describe('Detalle: horario del día', () => {
  it('today in progress: expected, in schedule, punctual, "En curso", offline; sessions show the time outside', async () => {
    renderApp(backendOf(db(true), ADMIN), '/colaborador/ana?fecha=2026-09-29');
    const cards = await screen.findByRole('region', { name: 'Cumplimiento del día' });
    expect(screen.getByTestId('day-schedule')).toHaveTextContent('Horario general09:00–18:30, colación 13:00–14:00En curso');
    expect(cards).toHaveTextContent('Esperado8 h 30 min5 h 30 min hasta ahora');
    expect(cards).toHaveTextContent('En horario5 h 28 minfuera de horario 0 min · colación 1 h 00 min');
    expect(cards).toHaveTextContent('AtrasoPuntualllegó a las 09:00');
    expect(cards).toHaveTextContent('Salida anticipadaEn cursose sabe al terminar el horario');
    expect(cards).toHaveTextContent('Sin conexión en horario2 minhasta ahora');
    const jornadas = screen.getByRole('region', { name: 'Jornadas del día' });
    expect(within(jornadas).getByRole('columnheader', { name: 'Fuera de horario' })).toBeInTheDocument();
    expect(jornadas).toHaveTextContent('0 mincolación 1 h 00 min');
    // Timeline covers the scheduled hours (09:00 → 18:00 rows) with marks.
    expect(document.querySelectorAll('.cell .sch-mark')).toHaveLength(2);
    expect(document.querySelectorAll('.cell.sch-lunch')).toHaveLength(6);
  });

  it('personalized schedule: lateness and early leave once the day is over', async () => {
    renderApp(backendOf(db(true), ADMIN), '/colaborador/beto?fecha=2026-09-29');
    const cards = await screen.findByRole('region', { name: 'Cumplimiento del día' });
    expect(screen.getByTestId('day-schedule')).toHaveTextContent('Horario personalizado09:30–12:00, sin colación');
    expect(screen.getByTestId('day-schedule')).not.toHaveTextContent('En curso');
    expect(cards).toHaveTextContent('Esperado2 h 30 minsin la colación');
    expect(cards).toHaveTextContent('Atraso30 minllegó a las 10:00');
    expect(cards).toHaveTextContent('Salida anticipada1 h 00 minsalió a las 11:00');
    expect(cards).toHaveTextContent('Sin conexión en horario1 h 30 min');
  });

  it('a holiday: no expected time, everything outside the schedule; absence on a past workday', async () => {
    const data = db(true);
    data.schedule = general({ holidays: ['2026-09-29'] });
    data.schedules = {};
    const { unmount } = renderApp(backendOf(data, ADMIN), '/colaborador/ana?fecha=2026-09-29');
    expect(await screen.findByTestId('day-schedule')).toHaveTextContent('Feriado');
    expect(screen.queryByRole('region', { name: 'Cumplimiento del día' })).toBeNull();
    expect(screen.getByText(/No se espera trabajo este día/)).toHaveTextContent('(6 h 28 min)');
    unmount();

    renderApp(backendOf(db(true), ADMIN), '/colaborador/ana?fecha=2026-09-28');
    expect(await screen.findByTestId('day-schedule')).toHaveTextContent('Ausente');
    expect(screen.getByRole('region', { name: 'Cumplimiento del día' })).toHaveTextContent('Sin conexión en horario8 h 30 min');
  });

  it('without a schedule there are no cards', async () => {
    renderApp(backendOf(db(false), ADMIN), '/colaborador/ana?fecha=2026-09-29');
    await screen.findByRole('region', { name: 'Resumen del día' });
    expect(screen.queryByText('Horario del día')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Fuera de horario' })).toBeNull();
  });
});

describe('Equipo: totales de horario', () => {
  it('shows the period totals of the schedule above the table', async () => {
    renderApp(backendOf(db(true), ADMIN));
    const stats = await screen.findByRole('region', { name: 'Horario del periodo' });
    expect(stats).toHaveTextContent('Horas esperadas13 h 30 minen horario 6 h 28 min');
    expect(stats).toHaveTextContent('Atrasos130 min en total');
    expect(stats).toHaveTextContent('Sin conexión en horario7 h 02 min');
    expect(stats).toHaveTextContent('Ausencias0 días');
  });
});

describe('Equipo: días antes de unirse', () => {
  const ctx = { config: general(), persons: new Map<string, PersonSchedule>() };
  // Monday 21 → Tuesday 29 (NOW): 7 workdays with the default week.
  const from = '2026-09-21';
  const to = '2026-09-29';

  it('without joinedAt every workday counts (6 past absences)', () => {
    const tc = teamCompliance(['ana'], [], ctx, from, to, NOW)!;
    expect(tc.byUid.get('ana')!.totals!.absentDays).toBe(6);
  });

  it('does not count absences nor offline time before the person joined', () => {
    // Joined on Monday 28: only the 28th (absent) and the 29th (ongoing) count.
    const joined = new Map([['ana', Date.UTC(2026, 8, 28, 15)]]);
    const t = teamCompliance(['ana'], [], ctx, from, to, NOW, joined)!.byUid.get('ana')!.totals!;
    expect(t.absentDays).toBe(1);
    expect(t.days).toBe(2);
    // 28th: 8 h 30; 29th until 15:30: 4 h + 1 h 30.
    expect(t.expectedSoFarSeconds).toBe((8.5 + 5.5) * 3600);
    expect(t.offlineSeconds).toBe(t.expectedSoFarSeconds);
  });

  it('an earlier session still counts from its day, and joining after the period gives zeros', () => {
    const joined = new Map([['ana', Date.UTC(2026, 8, 28, 15)]]);
    const early = { uid: 'ana', startedAt: Date.UTC(2026, 8, 24, 13), endedAt: Date.UTC(2026, 8, 24, 14), endReason: 'manual' as const, lastHeartbeatAt: Date.UTC(2026, 8, 24, 14) };
    const t = teamCompliance(['ana'], [early], ctx, from, to, NOW, joined)!.byUid.get('ana')!.totals!;
    expect(t.days).toBe(6); // 24 → 29
    const late = teamCompliance(['ana'], [], ctx, from, to, NOW, new Map([['ana', Date.UTC(2026, 9, 5)]]))!;
    expect(late.byUid.get('ana')!.totals!.days).toBe(0);
    expect(late.totals.absentDays).toBe(0);
  });
});
