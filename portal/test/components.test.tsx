import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeTeam, type OrgConfig } from '@timetracking/shared';
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
import { isPlaceholderInstallUrl } from '../src/env';
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
    allowedDomain: 'compratuparcela.cl',
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

describe('InviteForm', () => {
  it('validates the domain before writing and reports success', async () => {
    const onInvite = vi.fn(async () => undefined);
    render(<InviteForm allowedDomain="compratuparcela.cl" invitations={[]} users={[]} onInvite={onInvite} />);
    const input = screen.getByLabelText('Correo de la persona');
    await userEvent.type(input, 'alguien@gmail.com');
    await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Solo puedes invitar correos @compratuparcela.cl.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onInvite).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, 'Nueva@CompraTuParcela.cl');
    await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    expect(onInvite).toHaveBeenCalledWith('nueva@compratuparcela.cl', 'nueva@compratuparcela.cl');
    expect(await screen.findByRole('status')).toHaveTextContent('Invitación enviada a nueva@compratuparcela.cl.');
    expect(input).toHaveValue('');
  });

  it('shows write errors', async () => {
    const onInvite = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 'permission-denied' });
    });
    render(<InviteForm allowedDomain="compratuparcela.cl" invitations={[]} users={[]} onInvite={onInvite} />);
    await userEvent.type(screen.getByLabelText('Correo de la persona'), 'a@compratuparcela.cl');
    await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No tienes permiso para hacer esto.');
  });
});

describe('SettingsForm', () => {
  const config: OrgConfig = {
    allowedDomain: 'compratuparcela.cl',
    screenshotsEnabled: false,
    blurScreenshots: true,
    screenshotRetentionDays: 90,
    updatedAt: NOW,
    updatedBy: 'system',
  };

  it('rejects invalid retention and saves valid values', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<SettingsForm config={config} onSave={onSave} />);
    const days = screen.getByLabelText('Conservar capturas (días)');
    await userEvent.clear(days);
    await userEvent.type(days, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(screen.getByRole('alert')).toHaveTextContent('entre 1 y 3650');
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.clear(days);
    await userEvent.type(days, '30');
    await userEvent.click(screen.getByLabelText(/Tomar capturas/));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onSave).toHaveBeenCalledWith({
      allowedDomain: 'compratuparcela.cl',
      screenshotsEnabled: true,
      blurScreenshots: true,
      screenshotRetentionDays: '30',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Configuración guardada');
  });

  it('the domain is read-only until "Cambiar", which shows a warning', async () => {
    render(<SettingsForm config={config} onSave={vi.fn()} />);
    const domain = screen.getByLabelText('Dominio de Google Workspace');
    expect(domain).toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar' }));
    expect(domain).not.toHaveAttribute('readonly');
    expect(screen.getByText(/si cambias el dominio/)).toBeInTheDocument();
    await userEvent.clear(domain);
    await userEvent.type(domain, 'otra.cl');
    expect(screen.getByRole('button', { name: 'Guardar y cambiar dominio' })).toBeInTheDocument();
  });
});

describe('Configuración page', () => {
  it('writes the 6 fields with the admin uid', async () => {
    const db = seededDb();
    const backend = backendOf(db, ADMIN);
    renderApp(backend, '/configuracion');
    await userEvent.click(await screen.findByLabelText(/Difuminar capturas/));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(backend.data.saveOrgConfig).toHaveBeenCalled());
    expect(db.config).toEqual({
      allowedDomain: 'compratuparcela.cl',
      screenshotsEnabled: true,
      blurScreenshots: false,
      screenshotRetentionDays: 90,
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
    expect(await screen.findByLabelText('Rol de Jefa Pérez')).toBeDisabled();
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
