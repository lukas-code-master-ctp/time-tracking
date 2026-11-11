import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonedDateTimeToMs } from '@timetracking/shared';
import { attendanceFormError, kioskIdOf, kioskUrl, newKioskToken } from '../src/lib/attendance';
import { PunchError, type Punch } from '../src/lib/kioskClient';
import { KIOSK_TOKEN_KEY, KioskPage, RESULT_MS } from '../src/pages/KioskPage';

describe('attendance helpers', () => {
  it('kiosk tokens are random base64url and their id is the SHA-256 in hex', async () => {
    const a = newKioskToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newKioskToken()).not.toBe(a);
    expect(await kioskIdOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(kioskUrl('https://app.mipegahr.cl/', 'tok')).toBe('https://app.mipegahr.cl/marcar#tok');
  });

  it('validates the RUT and its uniqueness', () => {
    const none = new Set<string>();
    expect(attendanceFormError({ rut: '', mode: 'extension' }, none)).toBeNull();
    expect(attendanceFormError({ rut: '', mode: 'kiosk' }, none)).toMatch(/necesita un RUT/);
    expect(attendanceFormError({ rut: '12.345.678-4', mode: 'both' }, none)).toMatch(/no es válido/);
    expect(attendanceFormError({ rut: '12.345.678-5', mode: 'both' }, new Set(['12345678-5']))).toMatch(/otra persona/);
    expect(attendanceFormError({ rut: '12.345.678-5', mode: 'kiosk' }, none)).toBeNull();
  });
});

describe('KioskPage', () => {
  const NOW = zonedDateTimeToMs('2026-11-10', '09:02');

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderKiosk(punch: Punch, hash = '') {
    window.history.replaceState(null, '', `/marcar${hash}`);
    return render(
      <MemoryRouter initialEntries={['/marcar']}>
        <Routes>
          <Route path="/marcar" element={<KioskPage getPunch={() => punch} />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  const type = (keys: string) => {
    for (const k of keys) fireEvent.click(screen.getByRole('button', { name: k }));
  };

  it('without a token: explains how to activate the device', () => {
    renderKiosk(vi.fn());
    expect(screen.getByRole('heading', { name: /aún no es un tótem/ })).toBeTruthy();
  });

  it('saves the token of the link, marks the entry with the RUT and goes back to the keypad', async () => {
    const token = 't'.repeat(43);
    const punch = vi.fn<Punch>(async ({ action }) => ({ action, firstName: 'Ana', at: NOW, startedAt: NOW }));
    renderKiosk(punch, `#${token}`);
    expect(localStorage.getItem(KIOSK_TOKEN_KEY)).toBe(token);
    expect(window.location.hash).toBe('');

    const entrada = screen.getByRole('button', { name: 'Entrada' }) as HTMLButtonElement;
    expect(entrada.disabled).toBe(true);
    type('123456785');
    expect(screen.getByLabelText('RUT').textContent).toBe('12.345.678-5');
    fireEvent.click(entrada);
    await screen.findByText('¡Hola, Ana!');
    expect(screen.getByText('Entrada registrada a las 09:02')).toBeTruthy();
    expect(punch).toHaveBeenCalledWith({ token, rut: '12345678-5', action: 'in' });

    await act(async () => {
      vi.advanceTimersByTime(RESULT_MS);
    });
    await waitFor(() => expect(screen.queryByText('¡Hola, Ana!')).toBeNull());
    expect(screen.getByLabelText('RUT').textContent).toBe('12.345.678-9');
  });

  it('shows the reason when the mark is refused', async () => {
    localStorage.setItem(KIOSK_TOKEN_KEY, 'x'.repeat(43));
    const punch = vi.fn<Punch>(async () => {
      throw new PunchError('not-in', 'No tienes una entrada marcada hoy. Marca primero tu entrada.');
    });
    renderKiosk(punch);
    type('123456785');
    fireEvent.click(screen.getByRole('button', { name: 'Salida' }));
    await screen.findByText('No se pudo marcar');
    expect(screen.getByText(/No tienes una entrada marcada hoy/)).toBeTruthy();
  });
});

describe('AttendancePage', () => {
  const NOW = Date.UTC(2026, 10, 10, 15, 0); // Tuesday 12:00 in Santiago
  const at = (time: string) => zonedDateTimeToMs('2026-11-10', time);

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the marks, saves the RUT and mode, and creates a kiosk link', async () => {
    const { App } = await import('../src/App');
    const { BackendProvider } = await import('../src/data/context');
    const { ADMIN, backendOf, emptyDb, member } = await import('./fakes');
    const user = (await import('@testing-library/user-event')).default.setup({ advanceTimers: vi.advanceTimersByTime });
    const d = emptyDb();
    d.users = [ADMIN, member('ana', 'Ana Pérez'), member('bruno', 'Bruno Díaz')];
    d.sessions = [
      { id: 's1', uid: 'ana', startedAt: at('09:02'), endedAt: null, endReason: null, lastHeartbeatAt: at('09:02'), source: 'kiosk', kioskId: 'k' },
      { id: 's2', uid: 'bruno', startedAt: at('08:50'), endedAt: at('11:00'), endReason: 'manual', lastHeartbeatAt: at('11:00') },
    ];
    d.attendancePhotos = [
      { id: 's1_in', uid: 'ana', sessionId: 's1', kind: 'in', at: at('09:02'), date: '2026-11-10', kioskId: 'k', path: 'attendancePhotos/ana/x/s1-in.jpg' },
    ];
    const backend = backendOf(d, ADMIN);
    render(
      <BackendProvider backend={backend}>
        <MemoryRouter initialEntries={['/colaboradores/marcaciones']}>
          <App />
        </MemoryRouter>
      </BackendProvider>,
    );
    const table = await screen.findByRole('table');
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Bruno Díaz');
    expect(rows[0]!.textContent).toContain('08:50');
    expect(rows[1]!.textContent).toContain('Tótem');
    expect(rows[1]!.textContent).toContain('En curso');
    expect(rows[1]!.textContent).toContain('2 h 58 min');
    // The kiosk's entry photo, bigger on click.
    const thumb = await within(rows[1] as HTMLElement).findByRole('button', { name: 'Foto de entrada de Ana Pérez' });
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: /Foto/ })).toBeNull();
    await user.click(thumb);
    expect((await screen.findByRole('img', { name: 'Foto de entrada de Ana Pérez' })).getAttribute('src')).toContain('s1-in.jpg');
    await user.keyboard('{Escape}');

    await user.type(screen.getByLabelText('RUT de Ana Pérez'), '12345678-5');
    await user.selectOptions(screen.getByLabelText('Cómo marca Ana Pérez'), 'kiosk');
    const anaRow = screen.getByLabelText('RUT de Ana Pérez').closest('li')!;
    await user.click(within(anaRow).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(d.attendance?.find((a) => a.id === 'ana')).toMatchObject({ rut: '12345678-5', mode: 'kiosk', updatedBy: ADMIN.id }));

    await user.type(screen.getByLabelText('Nombre del tótem'), 'Recepción');
    await user.click(screen.getByRole('button', { name: 'Crear tótem' }));
    await screen.findByText(/Tótem “Recepción” creado/);
    expect(d.kiosks).toHaveLength(1);
    expect(d.kiosks![0]!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(document.querySelector('.kiosk-link code')!.textContent).toMatch(/\/marcar#[A-Za-z0-9_-]{43}$/);
  });
});
