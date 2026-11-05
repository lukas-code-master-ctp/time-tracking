import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { BackendProvider } from '../src/data/context';
import type { Backend } from '../src/data/types';
import { buildCelebration, celebrationFormError, celebrationToForm } from '../src/lib/celebrations';
import { ADMIN, backendOf, emptyDb, member, type FakeDb } from './fakes';

// 2026-11-05 (Thursday) 12:00 in Santiago.
const NOW = Date.UTC(2026, 10, 5, 15, 0);

function renderApp(backend: Backend, path: string) {
  return render(
    <BackendProvider backend={backend}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </BackendProvider>,
  );
}

function db(): FakeDb {
  const d = emptyDb();
  d.users = [ADMIN, member('ana', 'Ana Pérez'), member('bruno', 'Bruno Díaz'), member('dora', 'Dora', { status: 'disabled' })];
  d.celebrations = [
    { id: 'ana', displayName: 'Ana Pérez', birthday: '11-05', hireDate: null, active: true, updatedAt: 0, updatedBy: ADMIN.id },
    { id: 'bruno', displayName: 'Bruno Díaz', birthday: null, hireDate: '2023-11-12', active: true, updatedAt: 0, updatedBy: ADMIN.id },
    { id: 'dora', displayName: 'Dora', birthday: '11-06', hireDate: null, active: false, updatedAt: 0, updatedBy: ADMIN.id },
  ];
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('celebrations form', () => {
  it('round-trips and validates', () => {
    const f = celebrationToForm({ displayName: 'Ana', birthday: '03-14', hireDate: '2022-01-10', active: true, updatedAt: 0, updatedBy: 'x' });
    expect(f).toEqual({ birthMonth: '03', birthDay: '14', hireDate: '2022-01-10' });
    expect(celebrationFormError({ ...f, birthDay: '' }, '2026-11-05')).toMatch(/día y el mes/);
    expect(celebrationFormError({ ...f, birthMonth: '02', birthDay: '30' }, '2026-11-05')).toMatch(/cumpleaños/);
    expect(celebrationFormError({ ...f, hireDate: '2027-01-01' }, '2026-11-05')).toMatch(/futura/);
    expect(buildCelebration(member('ana', 'Ana'), f, 'admin-1', 5)).toEqual({
      displayName: 'Ana',
      birthday: '03-14',
      hireDate: '2022-01-10',
      active: true,
      updatedAt: 5,
      updatedBy: 'admin-1',
    });
  });
});

describe('CelebrationsPage', () => {
  it('lists the upcoming dates of active people and saves a person', async () => {
    const d = db();
    const backend = backendOf(d, ADMIN);
    renderApp(backend, '/colaboradores/fechas');
    const upcoming = await screen.findByRole('region', { name: 'Próximas fechas' });
    const items = within(upcoming).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Ana Pérez');
    expect(items[0]).toHaveTextContent('Hoy');
    expect(items[1]).toHaveTextContent('3 años en la empresa');
    expect(within(upcoming).queryByText('Dora')).toBeNull();

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.selectOptions(screen.getByLabelText('Día del cumpleaños de Lukas Admin'), '14');
    await user.selectOptions(screen.getByLabelText('Mes del cumpleaños de Lukas Admin'), '03');
    const row = screen.getByLabelText('Día del cumpleaños de Lukas Admin').closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Guardar' }));
    expect(await within(row).findByText('Guardado')).toBeInTheDocument();
    expect(d.celebrations?.find((c) => c.id === ADMIN.id)).toMatchObject({ birthday: '03-14', hireDate: null, active: true });
  });

  it('deactivating a person hides their birthday', async () => {
    const d = db();
    renderApp(backendOf(d, ADMIN), '/colaboradores');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const row = (await screen.findByText('Ana Pérez')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Desactivar' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Desactivar' }));
    await vi.waitFor(() => expect(d.celebrations?.find((c) => c.id === 'ana')?.active).toBe(false));
  });
});
