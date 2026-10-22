import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHILE_HOLIDAY_DATES, type Absence, type WithId } from '@timetracking/shared';
import { App } from '../src/App';
import { BackendProvider } from '../src/data/context';
import type { Backend } from '../src/data/types';
import { absenceToForm, buildAbsence, decideAbsence, emptyAbsenceForm, sortAbsences, validateAbsenceForm } from '../src/lib/absences';
import { dayBounds } from '../src/lib/dates';
import { DEFAULT_WEEK } from '../src/lib/schedule';
import { buildTimeline } from '../src/lib/timeline';
import { ADMIN, backendOf, emptyDb, member, type FakeDb } from './fakes';

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

function absence(overrides: Partial<WithId<Absence>> = {}): WithId<Absence> {
  return {
    id: 'abs-ana',
    uid: 'ana',
    type: 'vacation',
    startDate: '2026-09-28',
    endDate: '2026-09-28',
    startTime: null,
    endTime: null,
    note: '',
    createdAt: NOW - 86_400_000,
    createdBy: ADMIN.id,
    updatedAt: NOW - 86_400_000,
    updatedBy: ADMIN.id,
    ...overrides,
  };
}

/** Ana: no session on Monday 28 (absent), Tuesday 29 from 11:00 (late without a justification). */
function db(): FakeDb {
  const d = emptyDb();
  d.config = {
    allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
    screenshotsEnabled: true,
    blurScreenshots: true,
    screenshotRetentionDays: 90,
    updatedAt: NOW - 3_600_000,
    updatedBy: 'system',
  };
  d.schedule = {
    week: DEFAULT_WEEK,
    holidays: [...CHILE_HOLIDAY_DATES],
    toleranceMinutes: 5,
    remindersEnabled: true,
    updatedAt: NOW - 86_400_000,
    updatedBy: 'otro-admin',
  };
  d.users = [ADMIN, member('ana', 'Ana Rojas')];
  d.sessions = [{ id: 's-ana', uid: 'ana', startedAt: at(11), endedAt: null, endReason: null, lastHeartbeatAt: NOW - 2 * M }];
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('absence form helpers', () => {
  it('builds whole days and hours exactly as the rules accept them', () => {
    const days = buildAbsence({ ...emptyAbsenceForm('2026-11-02'), endDate: '2026-11-13', note: '  aprobadas ' }, 'ana', ADMIN.id, NOW + 0.4);
    expect(days).toEqual({
      uid: 'ana',
      type: 'vacation',
      startDate: '2026-11-02',
      endDate: '2026-11-13',
      startTime: null,
      endTime: null,
      note: 'aprobadas',
      status: 'approved',
      createdAt: NOW,
      createdBy: ADMIN.id,
      updatedAt: NOW,
      updatedBy: ADMIN.id,
    });
    // By hours: one day, whatever "Hasta" said in the other mode.
    const hours = buildAbsence({ ...emptyAbsenceForm('2026-11-02'), mode: 'hours', type: 'errand', endDate: '2026-11-13' }, 'ana', ADMIN.id, NOW);
    expect(hours).toMatchObject({ startDate: '2026-11-02', endDate: '2026-11-02', startTime: '09:00', endTime: '11:00' });
  });

  it('a change keeps the person and the creation', () => {
    const existing = absence();
    const doc = buildAbsence({ ...absenceToForm(existing), type: 'medical' }, 'otro', 'admin-2', NOW, existing);
    expect(doc).toMatchObject({ uid: 'ana', type: 'medical', createdAt: existing.createdAt, createdBy: ADMIN.id, updatedBy: 'admin-2', updatedAt: NOW });
  });

  it('validates and sorts', () => {
    expect(validateAbsenceForm({ ...emptyAbsenceForm('2026-11-02'), type: 'other' }).map((i) => i.path)).toEqual(['note']);
    expect(() => buildAbsence({ ...emptyAbsenceForm('2026-11-02'), endDate: '2026-11-01' }, 'ana', ADMIN.id, NOW)).toThrow('anterior');
    const list = sortAbsences([absence({ id: 'a' }), absence({ id: 'b', startDate: '2026-10-01', endDate: '2026-10-01' })]);
    expect(list.map((a) => a.id)).toEqual(['b', 'a']);
  });
});

describe('Detalle: ausencias justificadas', () => {
  it('a justified day is not an absence and shows its type', async () => {
    const data = db();
    data.absences = [absence({ note: 'Vacaciones de primavera' })];
    renderApp(backendOf(data, ADMIN), '/colaborador/ana?fecha=2026-09-28');
    const schedule = await screen.findByTestId('day-schedule');
    expect(schedule).toHaveTextContent('Vacaciones');
    expect(schedule).not.toHaveTextContent('Ausente');
    const cards = screen.getByRole('region', { name: 'Cumplimiento del día' });
    expect(cards).toHaveTextContent('Sin conexión en horario0 min');
    expect(cards).toHaveTextContent('Justificado8 h 30 mintodo el día');
    expect(within(screen.getByTestId('absence-list')).getByText('Vacaciones · 28-09-2026, día completo')).toBeInTheDocument();
  });

  it('adds an errand by hours: the late arrival goes away', async () => {
    const user = userEvent.setup();
    const backend = backendOf(db(), ADMIN);
    renderApp(backend, '/colaborador/ana?fecha=2026-09-29');
    const cards = await screen.findByRole('region', { name: 'Cumplimiento del día' });
    expect(cards).toHaveTextContent('Atraso2 h 00 min');

    await user.click(screen.getByRole('button', { name: 'Agregar ausencia' }));
    const dialog = screen.getByRole('dialog', { name: 'Agregar ausencia' });
    await user.selectOptions(within(dialog).getByLabelText('Tipo'), 'Trámite');
    await user.click(within(dialog).getByRole('button', { name: 'Por horas' }));
    expect(within(dialog).getByLabelText('Día')).toHaveValue('2026-09-29');
    await user.clear(within(dialog).getByLabelText('Hasta'));
    await user.type(within(dialog).getByLabelText('Hasta'), '11:00');
    await user.type(within(dialog).getByLabelText('Comentario (opcional)'), 'Notaría');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(backend.data.saveAbsence).toHaveBeenCalledWith(null, {
      uid: 'ana',
      type: 'errand',
      startDate: '2026-09-29',
      endDate: '2026-09-29',
      startTime: '09:00',
      endTime: '11:00',
      note: 'Notaría',
      status: 'approved',
      createdAt: NOW,
      createdBy: ADMIN.id,
      updatedAt: NOW,
      updatedBy: ADMIN.id,
    });
    expect(await screen.findByText('Trámite · 29-09-2026, 09:00–11:00')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cumplimiento del día' })).toHaveTextContent('AtrasoPuntual');
    expect(screen.getByTestId('day-schedule')).toHaveTextContent('Trámite 09:00–11:00');
  });

  it('"Otro" needs a comment; deleting asks first', async () => {
    const user = userEvent.setup();
    const data = db();
    data.absences = [absence()];
    const backend = backendOf(data, ADMIN);
    renderApp(backend, '/colaborador/ana?fecha=2026-09-28');
    await screen.findByTestId('absence-list');

    await user.click(screen.getByRole('button', { name: 'Agregar ausencia' }));
    const dialog = screen.getByRole('dialog', { name: 'Agregar ausencia' });
    await user.selectOptions(within(dialog).getByLabelText('Tipo'), 'Otro');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('escribe un comentario');
    expect(backend.data.saveAbsence).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await user.click(screen.getByRole('button', { name: 'Eliminar Vacaciones · 28-09-2026, día completo' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Eliminar ausencia' })).getByRole('button', { name: 'Eliminar' }));
    expect(backend.data.deleteAbsence).toHaveBeenCalledWith('abs-ana');
    expect(await screen.findByTestId('day-schedule')).toHaveTextContent('Ausente');
  });
});

describe('Solicitudes desde la extensión', () => {
  const request = (o: Partial<WithId<Absence>> = {}) =>
    absence({ id: 'req-1', status: 'pending', createdBy: 'ana', updatedBy: 'ana', type: 'medical', note: 'Licencia 1 día', ...o });

  it('editing or deciding keeps the person, the creation and (when editing) the status', () => {
    const r = request();
    expect(buildAbsence(absenceToForm(r), 'ana', ADMIN.id, NOW, r).status).toBe('pending');
    expect(decideAbsence(r, 'approved', ADMIN.id, NOW)).toEqual({ ...request(), id: undefined, status: 'approved', updatedBy: ADMIN.id, updatedAt: NOW });
  });

  it('a pending request justifies nothing until an admin approves it on the team page', async () => {
    const user = userEvent.setup();
    const data = db();
    data.absences = [request()];
    const backend = backendOf(data, ADMIN);
    renderApp(backend, '/?rango=custom&desde=2026-09-28&hasta=2026-09-28');
    const box = await screen.findByTestId('pending-requests');
    expect(box).toHaveTextContent('Ana Rojas · Licencia médica · 28-09-2026, día completo');
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    const cell = (h: string) => within(table).getByText('Ana Rojas').closest('tr')!.querySelectorAll('td')[headers.indexOf(h)]!.textContent;
    expect(cell('Ausencias')).toBe('1 día');

    await user.click(within(box).getByRole('button', { name: /^Aprobar/ }));
    expect(backend.data.saveAbsence).toHaveBeenCalledWith('req-1', expect.objectContaining({ status: 'approved', updatedBy: ADMIN.id, createdBy: 'ana' }));
    await vi.waitFor(() => expect(screen.queryByTestId('pending-requests')).toBeNull());
    await vi.waitFor(() => expect(cell('Ausencias')).toBe('0'));
  });

  it('the collaborator page shows the status and can reject', async () => {
    const user = userEvent.setup();
    const data = db();
    data.absences = [request()];
    const backend = backendOf(data, ADMIN);
    renderApp(backend, '/colaborador/ana?fecha=2026-09-28');
    const list = await screen.findByTestId('absence-list');
    expect(list).toHaveTextContent('Pendiente');
    expect(list).toHaveTextContent('Solicitada desde la extensión');
    expect(screen.getByTestId('day-schedule')).toHaveTextContent('Licencia médica (pendiente)');
    expect(screen.getByTestId('day-schedule')).toHaveTextContent('Ausente');
    await user.click(within(list).getByRole('button', { name: /^Rechazar/ }));
    expect(backend.data.saveAbsence).toHaveBeenCalledWith('req-1', expect.objectContaining({ status: 'rejected' }));
    expect(await within(await screen.findByTestId('absence-list')).findByText('Rechazada')).toBeInTheDocument();
  });
});

describe('Equipo: ausencias justificadas', () => {
  it('justified days are not counted as absences and show in "Justificado"', async () => {
    const data = db();
    data.absences = [absence()];
    renderApp(backendOf(data, ADMIN), '/?rango=custom&desde=2026-09-28&hasta=2026-09-28');
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    const row = within(table).getByText('Ana Rojas').closest('tr')!;
    const cell = (h: string) => row.querySelectorAll('td')[headers.indexOf(h)]!.textContent;
    expect(cell('Ausencias')).toBe('0');
    expect(cell('Justificado')).toBe('8 h 30 min1 día');
  });
});

describe('Timeline: ausencias justificadas', () => {
  it('outlines the blocks covered by an absence', () => {
    const t = buildTimeline(day.from, day.to, [], [], {
      absences: [absence({ startDate: '2026-09-29', endDate: '2026-09-29', type: 'errand', startTime: '09:00', endTime: '09:25' })],
      span: 'full',
    });
    const blocks = t.rows.flatMap((r) => r.blocks);
    expect(blocks.filter((b) => b.absence !== null).map((b) => b.label)).toEqual(['09:00', '09:10', '09:20']);
    expect(blocks.find((b) => b.label === '09:00')!.absence).toBe('Trámite');
  });
});
