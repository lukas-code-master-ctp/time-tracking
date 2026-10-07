import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secondsToHours, summarizeTeam, teamSummaryToCsv, type OrgConfig } from '@timetracking/shared';
import { App } from '../src/App';
import { TeamTable } from '../src/components/TeamTable';
import { Timeline } from '../src/components/Timeline';
import { ScreenshotGallery } from '../src/components/Screenshots';
import { BackendProvider } from '../src/data/context';
import { JoinError, type Backend } from '../src/data/types';
import { dayBounds, startOfDay } from '../src/lib/dates';
import { buildTimeline } from '../src/lib/timeline';
import { InstallUrlWarning, InviteForm } from '../src/pages/InvitationsPage';
import { RangePicker } from '../src/components/RangePicker';
import { ALLOWED_DOMAINS, allowedDomainsFromEnv, googleLoginParams, isPlaceholderInstallUrl } from '../src/env';
import { joinErrorMessage } from '../src/lib/messages';
import { presetRange } from '../src/lib/dates';
import { SettingsForm } from '../src/pages/SettingsPage';
import { ADMIN, backendOf, emptyDb, fakeAuth, fakeData, member, slot, type FakeDb } from './fakes';

const M = 60_000;
// 2026-09-29 15:30 in Santiago.
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

function seededDb(): FakeDb {
  const db = emptyDb();
  db.config = {
    allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
    screenshotsEnabled: true,
    blurScreenshots: true,
    screenshotRetentionDays: 90,
    updatedAt: NOW - 3_600_000,
    updatedBy: 'system',
  };
  db.users = [ADMIN, member('ana', 'Ana Rojas'), member('beto', 'Beto Díaz')];
  db.activity = [slot('ana', at(9), 600, 540), slot('ana', at(9, 10), 600, 300), slot('beto', at(10), 300, 60)];
  db.sessions = [
    { id: 's-ana', uid: 'ana', startedAt: at(9), endedAt: null, endReason: null, lastHeartbeatAt: NOW - 2 * M },
    { id: 's-beto', uid: 'beto', startedAt: at(10), endedAt: at(11), endReason: 'manual', lastHeartbeatAt: at(11) },
  ];
  db.screenshots = [
    { id: 'shot1', uid: 'ana', sessionId: 's-ana', takenAt: at(9, 4), storagePath: 'screenshots/ana/2026-09-29/shot1.jpg', blurred: true, width: 1280, height: 720 },
  ];
  return db;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('access gate', () => {
  it('a member sees "Sin acceso"', async () => {
    const b: Backend = {
      data: fakeData(emptyDb()),
      auth: fakeAuth({ uid: 'ana', email: 'ana@compratuparcela.cl', displayName: 'Ana' }, member('ana', 'Ana')),
    };
    renderApp(b);
    expect(await screen.findByRole('heading', { name: 'Sin acceso' })).toBeInTheDocument();
    expect(screen.getByText(/solo para administradores/)).toBeInTheDocument();
  });

  it('joinOrg rejection shows its message', async () => {
    const b: Backend = {
      data: fakeData(emptyDb()),
      auth: fakeAuth({ uid: 'x', email: 'x@gmail.com', displayName: null }, new JoinError('domain-not-allowed', 'Esta cuenta no es de la empresa.')),
    };
    renderApp(b);
    expect(await screen.findByText('Esta cuenta no es de la empresa.')).toBeInTheDocument();
  });

  it('signed out → login page', async () => {
    const b: Backend = { data: fakeData(emptyDb()), auth: fakeAuth(null, ADMIN) };
    renderApp(b);
    expect(await screen.findByRole('button', { name: 'Iniciar sesión con Google' })).toBeInTheDocument();
  });
});

describe('Equipo', () => {
  it('shows one row per collaborator with hours, activity and state', async () => {
    const backend = backendOf(seededDb(), ADMIN);
    renderApp(backend);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // header + 3 users + totals
    expect(rows).toHaveLength(5);
    const ana = rows.find((r) => r.textContent?.includes('Ana Rojas'))!;
    expect(ana).toHaveTextContent('En jornada');
    expect(ana).toHaveTextContent('70 %'); // 840 / 1200
    expect(ana).toHaveTextContent('6 h 28 min'); // 09:00 → heartbeat 15:28
    const beto = rows.find((r) => r.textContent?.includes('Beto Díaz'))!;
    expect(beto).toHaveTextContent('Fuera');
    expect(beto).toHaveTextContent('1 h 00 min');
    expect(beto).toHaveTextContent('20 %');
    expect(screen.getByText('1 de 3')).toBeInTheDocument();
    // Queries were done with the "today" range.
    expect(backend.data.listActivity).toHaveBeenCalledWith({ ...day, preset: 'today', fromDate: '2026-09-29', toDate: '2026-09-29' });
  });

  it('empty and error states', async () => {
    const db = emptyDb();
    db.users = [];
    renderApp({ data: fakeData(db), auth: fakeAuth({ uid: ADMIN.id, email: ADMIN.email, displayName: null }, ADMIN) });
    expect(await screen.findByText('Aún no hay colaboradores')).toBeInTheDocument();
  });

  it('error state with retry', async () => {
    const backend = backendOf(seededDb(), ADMIN);
    vi.mocked(backend.data.listActivity).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'unavailable' }));
    renderApp(backend);
    expect(await screen.findByText('No se pudieron cargar los datos')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('changing the range queries the new period', async () => {
    const backend = backendOf(seededDb(), ADMIN);
    renderApp(backend);
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Ayer' }));
    await waitFor(() =>
      expect(backend.data.listActivity).toHaveBeenLastCalledWith(expect.objectContaining({ fromDate: '2026-09-28', toDate: '2026-09-28' })),
    );
  });

  it('clicking a row opens the collaborator detail with timeline and screenshot', async () => {
    renderApp(backendOf(seededDb(), ADMIN));
    await userEvent.click(await screen.findByText('Ana Rojas'));
    expect(await screen.findByRole('heading', { name: 'Ana Rojas' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Línea de tiempo' })).toBeInTheDocument();
    expect(screen.getAllByTestId('timeline-cell')).toHaveLength(6);
    expect(screen.getByRole('button', { name: /Captura de las 09:04 \(difuminada\)/ })).toBeInTheDocument();
    expect(screen.getByText('Jornada abierta')).toBeInTheDocument();
    expect(screen.getByText('mail.google.com')).toBeInTheDocument();
  });
});

describe('En reunión', () => {
  function meetingDb(): FakeDb {
    const db = seededDb();
    db.activity = [
      // Ana: a 30-min daily (09:30–10:00) plus a normal block.
      slot('ana', at(9, 20), 600, 480),
      slot('ana', at(9, 30), 600, 30, { meetingSeconds: 540 }),
      slot('ana', at(9, 40), 600, 0, { meetingSeconds: 600 }),
      slot('ana', at(9, 50), 600, 60, { meetingSeconds: 480 }),
      // Beto: extension 0.1.1 (no meetingSeconds).
      slot('beto', at(10), 300, 60),
    ];
    return db;
  }

  it('Equipo: "En reunión" column and totals, same values as the CSV', async () => {
    const backend = backendOf(meetingDb(), ADMIN);
    renderApp(backend);
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toContain('En reunión');
    const col = headers.indexOf('En reunión');
    const rows = within(table).getAllByRole('row');
    const cell = (row: HTMLElement) => row.querySelectorAll('td, th')[col]!.textContent;
    const ana = rows.find((r) => r.textContent?.includes('Ana Rojas'))!;
    const beto = rows.find((r) => r.textContent?.includes('Beto Díaz'))!;
    const total = rows.find((r) => r.textContent?.includes('Total ('))!;
    expect(cell(ana)).toBe('27 min'); // 540 + 600 + 480 s
    expect(cell(beto)).toBe('0 min');
    expect(cell(total)).toBe('27 min');
    // % without the meeting: Ana (480 + 30 + 0 + 60) / (2400 - 1620) = 73 %.
    expect(ana).toHaveTextContent('73 %');
    expect(screen.getByRole('region', { name: 'Totales del periodo' })).toHaveTextContent('En reunión27 min');

    // The CSV export carries the same meeting time.
    const { buildTeam } = await import('../src/lib/team');
    const [users, slots, sessions] = await Promise.all([
      backend.data.listUsers(),
      backend.data.listActivity(day),
      backend.data.listSessions(day),
    ]);
    const csv = teamSummaryToCsv(buildTeam(users, slots, sessions, day, NOW), { separator: ';', decimalSeparator: ',' });
    const [head, ...lines] = csv.trim().split(/\r\n/);
    const idx = head!.split(';').indexOf('Horas en reunión');
    expect(idx).toBeGreaterThan(-1);
    const csvOf = (name: string) => lines.find((l) => l.startsWith(name))!.split(';')[idx];
    expect(csvOf('Ana Rojas')).toBe(String(secondsToHours(1620)).replace('.', ',')); // 0,45 h = 27 min
    expect(csvOf('Beto Díaz')).toBe('0');
  });

  it('member detail: "En reunión" card and the meeting blocks in the timeline', async () => {
    renderApp(backendOf(meetingDb(), ADMIN), '/colaborador/ana?fecha=2026-09-29');
    const stats = await screen.findByRole('region', { name: 'Resumen del día' });
    expect(stats).toHaveTextContent('En reunión27 min');
    expect(stats).toHaveTextContent('73 %');
    const cells = screen.getAllByTestId('timeline-cell');
    const b930 = cells.find((c) => c.getAttribute('aria-label')?.startsWith('09:30'))!;
    expect(b930).toHaveClass('lvl-meeting', 'has-meeting');
    expect(b930).toHaveTextContent('50'); // 30 / (600 - 540)
    const b940 = cells.find((c) => c.getAttribute('aria-label')?.startsWith('09:40'))!;
    expect(b940).toHaveClass('lvl-meeting');
    expect(b940).toHaveTextContent('—');
    const b920 = cells.find((c) => c.getAttribute('aria-label')?.startsWith('09:20'))!;
    expect(b920).not.toHaveClass('has-meeting');
    expect(b920).not.toHaveClass('lvl-meeting');
  });

  it('only meetings: the % shows "—" instead of "Sin datos"', async () => {
    const db = seededDb();
    db.activity = [slot('ana', at(9, 30), 600, 0, { meetingSeconds: 600 })];
    renderApp(backendOf(db, ADMIN), '/colaborador/ana?fecha=2026-09-29');
    const stats = await screen.findByRole('region', { name: 'Resumen del día' });
    expect(stats).toHaveTextContent('Actividad— (sin % de actividad: todo el tiempo medido fue en reunión)');
    expect(stats).toHaveTextContent('En reunión10 min');
    expect(stats).not.toHaveTextContent('Sin datos');
  });
});

describe('TeamTable', () => {
  it('links each collaborator to the detail of the chosen day', () => {
    const team = summarizeTeam(
      [{ ...member('ana', 'Ana'), uid: 'ana' }],
      [slot('ana', at(9))],
      [],
      { from: day.from, to: day.to, now: NOW },
    );
    render(
      <MemoryRouter>
        <TeamTable team={team} now={NOW} detailDate="2026-09-28" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Ana/ })).toHaveAttribute('href', '/colaborador/ana?fecha=2026-09-28');
    expect(screen.getAllByText('80 %')).toHaveLength(2); // row + totals
  });
});

describe('Timeline', () => {
  it('describes each block and shows the detail on hover/focus', async () => {
    const t = buildTimeline(day.from, day.to, [
      slot('ana', at(9, 10), 600, 540, { domains: { 'docs.google.com': 400, 'mail.google.com': 200 }, outsideChromeSeconds: 60 }),
    ]);
    const onOpen = vi.fn();
    render(<Timeline timeline={t} onOpenScreenshot={onOpen} />);
    const cells = screen.getAllByTestId('timeline-cell');
    expect(cells).toHaveLength(6);
    expect(cells[0]).toHaveAccessibleName('09:00–09:10: sin datos');
    expect(cells[1]).toHaveAccessibleName(
      '09:10–09:20: 90 % de actividad, medido 10 min, fuera de Chrome 1 min, sitios: docs.google.com, mail.google.com',
    );
    expect(cells[1]).toHaveClass('lvl-high');
    await userEvent.hover(cells[1]!);
    const detail = screen.getByTestId('timeline-detail');
    expect(detail).toHaveTextContent('90 % de actividad');
    expect(detail).toHaveTextContent('docs.google.com');
    expect(detail).toHaveTextContent('Fuera de Chrome1 min');
  });
});

describe('Timeline with meetings', () => {
  it('meeting color, marker, "—" and "En reunión X min" in the label, detail and legend', async () => {
    const t = buildTimeline(day.from, day.to, [
      slot('ana', at(9), 600, 60, { meetingSeconds: 480 }),
      slot('ana', at(9, 10), 600, 0, { meetingSeconds: 600 }),
      slot('ana', at(9, 20), 600, 400, { meetingSeconds: 60 }),
      slot('ana', at(9, 30), 600, 400),
    ]);
    render(<Timeline timeline={t} />);
    const [mostly, whole, some, none] = screen.getAllByTestId('timeline-cell');
    expect(mostly).toHaveClass('lvl-meeting', 'has-meeting');
    expect(mostly).toHaveTextContent('50');
    expect(mostly).toHaveAccessibleName(
      '09:00–09:10: 50 % de actividad, medido 10 min, en reunión 8 min, sitios: mail.google.com',
    );
    expect(whole).toHaveClass('lvl-meeting', 'has-meeting');
    expect(whole).toHaveTextContent('—');
    expect(whole).toHaveAccessibleName(
      '09:10–09:20: sin % de actividad (todo en reunión), medido 10 min, en reunión 10 min, sitios: mail.google.com',
    );
    // Some meeting: marker, but its own activity color (400 / 540 → 74 %).
    expect(some).toHaveClass('lvl-high', 'has-meeting');
    expect(some).not.toHaveClass('lvl-meeting');
    expect(some).toHaveTextContent('74');
    expect(none).toHaveClass('lvl-mid');
    expect(none).not.toHaveClass('has-meeting');

    await userEvent.hover(whole!);
    const detail = screen.getByTestId('timeline-detail');
    expect(detail).toHaveTextContent('Actividad: —');
    expect(detail).toHaveTextContent('En reunión');
    expect(detail).toHaveTextContent('En reunión10 min');
    await userEvent.hover(some!);
    expect(detail).toHaveTextContent('74 % de actividad');
    expect(detail).toHaveTextContent('En reunión1 min');
    await userEvent.hover(none!);
    expect(detail).not.toHaveTextContent('En reunión');

    const legend = screen.getByRole('list', { name: 'Leyenda' });
    expect(legend).toHaveTextContent('En reunión (la mitad del bloque o más)');
    expect(legend).toHaveTextContent('Con tiempo en reunión');
  });
});

describe('InviteForm', () => {
  const DOMAINS = ['impulseai.cl', 'compratuparcela.cl'];

  it('validates the domain before writing and reports success', async () => {
    const onInvite = vi.fn(async () => undefined);
    render(<InviteForm allowedDomains={DOMAINS} invitations={[]} users={[]} onInvite={onInvite} />);
    expect(screen.getByText(/Solo cuentas @impulseai\.cl o @compratuparcela\.cl\./)).toBeInTheDocument();
    const input = screen.getByLabelText('Correo de la persona');
    await userEvent.type(input, 'alguien@gmail.com');
    await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Solo puedes invitar correos @impulseai.cl o @compratuparcela.cl.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onInvite).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, 'a@sub.impulseai.cl');
    await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Solo puedes invitar correos');
    expect(onInvite).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, 'Nueva@CompraTuParcela.cl');
    await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    expect(onInvite).toHaveBeenCalledWith('nueva@compratuparcela.cl', 'nueva@compratuparcela.cl');
    expect(await screen.findByRole('status')).toHaveTextContent('Invitación creada para nueva@compratuparcela.cl. Comparte el enlace de instalación con la persona.');
    expect(input).toHaveValue('');

    await userEvent.type(input, 'Otro@ImpulseAI.cl');
    await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    expect(onInvite).toHaveBeenLastCalledWith('otro@impulseai.cl', 'otro@impulseai.cl');
  });

  it('shows write errors', async () => {
    const onInvite = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 'permission-denied' });
    });
    render(<InviteForm allowedDomains={['compratuparcela.cl']} invitations={[]} users={[]} onInvite={onInvite} />);
    expect(screen.getByLabelText('Correo de la persona')).toHaveAttribute('placeholder', 'nombre@compratuparcela.cl');
    await userEvent.type(screen.getByLabelText('Correo de la persona'), 'a@compratuparcela.cl');
    await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No tienes permiso para hacer esto.');
  });
});

describe('SettingsForm', () => {
  const config: OrgConfig = {
    allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
    screenshotsEnabled: false,
    blurScreenshots: true,
    screenshotRetentionDays: 90,
    updatedAt: NOW,
    updatedBy: 'system',
  };
  const domainItems = () =>
    within(screen.getByRole('list', { name: 'Dominios permitidos' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent);

  it('rejects invalid retention and saves valid values', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<SettingsForm config={config} adminEmail="lukas@impulseai.cl" onSave={onSave} />);
    const days = screen.getByLabelText('Conservar capturas (días)');
    await userEvent.clear(days);
    await userEvent.type(days, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(screen.getByRole('alert')).toHaveTextContent('entre 1 y 3650');
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.clear(days);
    await userEvent.type(days, '30');
    await userEvent.click(screen.getByLabelText(/Tomar capturas/));
    await userEvent.click(screen.getByLabelText(/Pausar el reloj en la colación/));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onSave).toHaveBeenCalledWith({
      allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
      screenshotsEnabled: true,
      blurScreenshots: true,
      screenshotRetentionDays: '30',
      pauseTimerAtLunch: true,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Configuración guardada');
  });

  it('lists the domains read-only until "Cambiar dominios", which shows a warning', async () => {
    render(<SettingsForm config={config} adminEmail="lukas@impulseai.cl" onSave={vi.fn()} />);
    expect(domainItems()).toEqual(['@impulseai.cltu cuenta', '@compratuparcela.cl']);
    expect(screen.queryByRole('button', { name: /Quitar/ })).toBeNull();
    expect(screen.queryByLabelText('Agregar dominio')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar dominios' }));
    expect(screen.getByText(/si quitas un dominio/)).toBeInTheDocument();
    expect(screen.getByLabelText('Agregar dominio')).toBeInTheDocument();
  });

  it('adds and removes domains; the admin own domain and the last one cannot be removed', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<SettingsForm config={config} adminEmail="lukas@impulseai.cl" onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar dominios' }));
    expect(screen.getByRole('button', { name: 'Quitar @impulseai.cl' })).toBeDisabled();

    const add = screen.getByLabelText('Agregar dominio');
    await userEvent.type(add, 'no dominio');
    await userEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('no es válido');
    await userEvent.clear(add);
    await userEvent.type(add, '@CompraTuParcela.cl');
    await userEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('@compratuparcela.cl ya está en la lista.');
    await userEvent.clear(add);
    // Enter adds the domain (it does not submit the form).
    await userEvent.type(add, ' Nueva.CL {enter}');
    expect(domainItems()).toEqual(['@impulseai.cltu cuentaQuitar', '@compratuparcela.clQuitar', '@nueva.clQuitar']);
    expect(add).toHaveValue('');
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Quitar @compratuparcela.cl' }));
    await userEvent.click(screen.getByRole('button', { name: 'Quitar @nueva.cl' }));
    expect(domainItems()).toEqual(['@impulseai.cltu cuentaQuitar']);
    expect(screen.getByRole('button', { name: 'Quitar @impulseai.cl' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Guardar y cambiar dominios' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ allowedDomains: ['impulseai.cl'] }));
  });

  it('does not save when the admin own domain is missing (e.g. an old config)', async () => {
    const onSave = vi.fn(async () => undefined);
    const legacy = { ...config, allowedDomains: undefined, allowedDomain: 'compratuparcela.cl' } as unknown as OrgConfig;
    render(<SettingsForm config={legacy} adminEmail="lukas@impulseai.cl" onSave={onSave} />);
    expect(domainItems()).toEqual(['@compratuparcela.cl']);
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(screen.getByRole('alert')).toHaveTextContent('No puedes quitar @impulseai.cl: es el dominio de tu propia cuenta.');
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cambiar dominios' }));
    expect(screen.getByRole('button', { name: 'Quitar @compratuparcela.cl' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Agregar dominio'), 'impulseai.cl');
    await userEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar y cambiar dominios' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ allowedDomains: ['compratuparcela.cl', 'impulseai.cl'] }));
  });
});

describe('Configuración page', () => {
  it('writes the 7 fields with the admin uid', async () => {
    const db = seededDb();
    const backend = backendOf(db, ADMIN);
    renderApp(backend, '/configuracion');
    await userEvent.click(await screen.findByLabelText(/Difuminar capturas/));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(backend.data.saveOrgConfig).toHaveBeenCalled());
    expect(db.config).toEqual({
      allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
      screenshotsEnabled: true,
      blurScreenshots: false,
      screenshotRetentionDays: 90,
      pauseTimerAtLunch: false,
      updatedAt: NOW,
      updatedBy: ADMIN.id,
    });
  });
});

describe('Colaboradores page', () => {
  it('asks for confirmation and cannot change oneself', async () => {
    const db = seededDb();
    const backend = backendOf(db, ADMIN);
    renderApp(backend, '/colaboradores');
    expect(await screen.findByLabelText('Rol de Lukas Admin')).toBeDisabled();
    const items = screen.getAllByRole('listitem');
    const self = items.find((i) => i.textContent?.includes('(tú)'))!;
    expect(within(self).getByRole('button', { name: 'Desactivar' })).toBeDisabled();

    const beto = items.find((i) => i.textContent?.includes('Beto Díaz'))!;
    await userEvent.click(within(beto).getByRole('button', { name: 'Desactivar' }));
    const dialog = screen.getByRole('dialog', { name: 'Desactivar cuenta' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(backend.data.updateUser).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByLabelText('Rol de Beto Díaz'), 'admin');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Hacer administrador' }));
    await waitFor(() => expect(backend.data.updateUser).toHaveBeenCalledWith('beto', { role: 'admin', status: 'active' }));
    expect(await screen.findByText('Cambios guardados para Beto Díaz.')).toBeInTheDocument();
  });
});

describe('Invitaciones page', () => {
  it('creates, resends and revokes with the rules-compatible documents', async () => {
    const db = seededDb();
    db.invitations = [{ id: 'vieja@compratuparcela.cl', email: 'vieja@compratuparcela.cl', invitedBy: 'otro', invitedAt: NOW - 1000, status: 'pending' }];
    const backend = backendOf(db, ADMIN);
    renderApp(backend, '/invitaciones');
    await userEvent.type(await screen.findByLabelText('Correo de la persona'), 'nuevo@compratuparcela.cl');
    await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    await waitFor(() =>
      expect(backend.data.putInvitation).toHaveBeenCalledWith('nuevo@compratuparcela.cl', {
        email: 'nuevo@compratuparcela.cl',
        invitedBy: ADMIN.id,
        invitedAt: NOW,
        status: 'pending',
      }),
    );

    const old = (await screen.findByText('vieja@compratuparcela.cl')).closest('li')!;
    await userEvent.click(within(old).getByRole('button', { name: 'Reenviar' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reenviar' }));
    await waitFor(() =>
      expect(backend.data.putInvitation).toHaveBeenLastCalledWith('vieja@compratuparcela.cl', {
        email: 'vieja@compratuparcela.cl',
        invitedBy: ADMIN.id,
        invitedAt: NOW,
        status: 'pending',
      }),
    );

    const again = (await screen.findByText('vieja@compratuparcela.cl')).closest('li')!;
    await userEvent.click(within(again).getByRole('button', { name: 'Revocar' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revocar' }));
    await waitFor(() => expect(db.invitations.find((i) => i.id === 'vieja@compratuparcela.cl')?.status).toBe('revoked'));
  });
});

describe('Equipo: refresco automático', () => {
  it('re-reads only today while live, pauses when hidden and "Actualizar" reads the whole range', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const backend = backendOf(seededDb(), ADMIN);
    renderApp(backend, '/?rango=thisMonth');
    await screen.findByRole('table');
    const month = { from: startOfDay('2026-09-01'), to: startOfDay('2026-10-01') };
    expect(backend.data.listActivity).toHaveBeenLastCalledWith(expect.objectContaining(month));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(backend.data.listActivity).toHaveBeenLastCalledWith({ from: day.from, to: month.to }));
    const calls = vi.mocked(backend.data.listActivity).mock.calls.length;

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(vi.mocked(backend.data.listActivity).mock.calls.length).toBe(calls);
    hidden.mockRestore();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(backend.data.listActivity).toHaveBeenLastCalledWith(expect.objectContaining(month)));
    // Totals still include the blocks kept from the previous read.
    expect(within(await screen.findByRole('table')).getAllByRole('row')).toHaveLength(5);
  });
});

describe('Lightbox', () => {
  it('does not show the previous image while the next one loads', async () => {
    const data = fakeData(emptyDb());
    vi.mocked(data.screenshotUrl).mockImplementation((path: string) =>
      path.endsWith('b.jpg') ? new Promise<string>(() => undefined) : Promise.resolve(`https://example.test/${path}`),
    );
    const shots = ['a', 'b'].map((id, i) => ({
      id,
      uid: 'ana',
      sessionId: 's',
      takenAt: at(9, i * 10 + 2),
      storagePath: `screenshots/ana/2026-09-29/${id}.jpg`,
      blurred: false,
      width: 1280,
      height: 720,
    }));
    function Harness() {
      const [open, setOpen] = useState<string | null>('a');
      return <ScreenshotGallery shots={shots} openId={open} onOpen={setOpen} onClose={() => setOpen(null)} />;
    }
    render(
      <BackendProvider backend={{ data, auth: fakeAuth(null, ADMIN) }}>
        <Harness />
      </BackendProvider>,
    );
    expect(await screen.findByTestId('lightbox-img')).toHaveAttribute('src', expect.stringContaining('a.jpg'));
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente →' }));
    expect(await screen.findByRole('heading', { name: 'Captura de las 09:12' })).toBeInTheDocument();
    expect(screen.queryByTestId('lightbox-img')).toBeNull();
    expect(within(screen.getByRole('dialog')).getByText('Cargando…')).toBeInTheDocument();
  });
});

describe('Dominios del login', () => {
  it('parses VITE_ALLOWED_DOMAIN as a list with defaults', () => {
    expect(allowedDomainsFromEnv(' ImpulseAI.cl, compratuparcela.cl ')).toEqual(['impulseai.cl', 'compratuparcela.cl']);
    expect(allowedDomainsFromEnv('')).toEqual(['impulseai.cl', 'compratuparcela.cl']);
    expect(allowedDomainsFromEnv(undefined)).toEqual(['impulseai.cl', 'compratuparcela.cl']);
    expect(allowedDomainsFromEnv('solo.cl')).toEqual(['solo.cl']);
    // Without VITE_ALLOWED_DOMAIN (vitest mode): the shared defaults.
    expect(ALLOWED_DOMAINS).toEqual(['impulseai.cl', 'compratuparcela.cl']);
  });

  it('sends hd only when there is a single domain', () => {
    expect(googleLoginParams(['compratuparcela.cl'])).toEqual({ hd: 'compratuparcela.cl', prompt: 'select_account' });
    expect(googleLoginParams(['impulseai.cl', 'compratuparcela.cl'])).toEqual({ prompt: 'select_account' });
    expect(googleLoginParams([])).toEqual({ prompt: 'select_account' });
  });

  it('the domain message lists every domain', () => {
    expect(joinErrorMessage('domain-not-allowed', ['impulseai.cl', 'compratuparcela.cl'])).toBe(
      'Esta cuenta no es de la empresa. Entra con tu cuenta @impulseai.cl o @compratuparcela.cl.',
    );
  });

  it('the login page shows the domains', async () => {
    renderApp({ data: fakeData(emptyDb()), auth: fakeAuth(null, ADMIN) });
    expect(await screen.findByText(/Usa tu cuenta @impulseai\.cl o @compratuparcela\.cl\./)).toBeInTheDocument();
  });
});

describe('Enlace de instalación', () => {
  it('detects placeholder links', () => {
    for (const url of ['', 'REEMPLAZAR_ENLACE_CHROME_WEB_STORE', 'https://chromewebstore.google.com/detail/dev-extension', 'http://x.cl', 'no es url']) {
      expect(isPlaceholderInstallUrl(url)).toBe(true);
    }
    expect(isPlaceholderInstallUrl('https://chromewebstore.google.com/detail/registro-de-jornada/abcdefghijklmnopabcdefghijklmnop')).toBe(false);
  });

  it('shows the warning only for a placeholder', () => {
    const { rerender } = render(<InstallUrlWarning url="REEMPLAZAR_ENLACE_CHROME_WEB_STORE" />);
    expect(screen.getByTestId('install-url-warning')).toHaveTextContent('VITE_EXTENSION_INSTALL_URL');
    rerender(<InstallUrlWarning url="https://chromewebstore.google.com/detail/x/abcdefghijklmnopabcdefghijklmnop" />);
    expect(screen.queryByTestId('install-url-warning')).toBeNull();
  });
});

describe('RangePicker: tope de 93 días', () => {
  it('moves the other end and explains it', () => {
    const onCustom = vi.fn();
    const range = presetRange('custom', NOW, undefined, { fromDate: '2026-09-01', toDate: '2026-09-29' });
    render(<RangePicker range={range} onPreset={() => undefined} onCustom={onCustom} />);
    expect(screen.getByText('Máximo 93 días.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-01-01' } });
    expect(onCustom).toHaveBeenLastCalledWith('2026-01-01', '2026-04-03');
    expect(screen.getByRole('status')).toHaveTextContent('como máximo 93 días');
  });

  it('warns when the URL asked for a longer range', () => {
    const range = presetRange('custom', NOW, undefined, { fromDate: '2025-01-01', toDate: '2026-09-29' });
    render(<RangePicker range={range} onPreset={() => undefined} onCustom={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('se ajustó a 29-06-2026 – 29-09-2026');
  });
});
