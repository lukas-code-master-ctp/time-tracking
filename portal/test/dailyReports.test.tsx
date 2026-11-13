import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile, WithId } from '@timetracking/shared';
import { App } from '../src/App';
import { BackendProvider } from '../src/data/context';
import type { Backend } from '../src/data/types';
import { ADMIN, backendOf, emptyDb } from './fakes';

// Friday 2026-11-13, 18:30 in Santiago.
const NOW = Date.UTC(2026, 10, 13, 21, 30);

const person = (id: string, displayName: string): WithId<UserProfile> => ({
  id,
  email: `${id}@impulseai.cl`,
  displayName,
  photoURL: null,
  role: 'member',
  status: 'active',
  createdAt: 1,
});
const group = (id: string, name: string, memberUids: string[]) => ({
  id,
  name,
  memberUids,
  createdAt: 1,
  createdBy: 'admin',
  updatedAt: 1,
  updatedBy: 'admin',
});

function renderApp(backend: Backend) {
  return render(
    <BackendProvider backend={backend}>
      <MemoryRouter initialEntries={['/minutas']}>
        <App />
      </MemoryRouter>
    </BackendProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const CONFIG = {
  allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
  screenshotsEnabled: true,
  blurScreenshots: false,
  screenshotRetentionDays: 30,
  moodPulseEnabled: true,
  updatedAt: 1,
  updatedBy: 'x',
};

describe('Minutas', () => {
  it('turns the report on for the chosen groups, keeping the rest of config/org', async () => {
    const db = emptyDb();
    db.config = { ...CONFIG };
    db.groups = [group('g1', 'Terreno', ['ana']), group('g2', 'Oficina', ['beto'])];
    renderApp(backendOf(db, ADMIN));
    await userEvent.click(await screen.findByLabelText(/Pedir la minuta del día/));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Elige al menos un grupo.')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Terreno/));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText(/Configuración guardada/)).toBeInTheDocument();
    expect(db.config).toMatchObject({ dailyReportEnabled: true, dailyReportGroupIds: ['g1'], moodPulseEnabled: true, screenshotRetentionDays: 30 });
  });

  it('lists the day: who sent it (with the transcript) and who did not', async () => {
    const db = emptyDb();
    db.config = { ...CONFIG, dailyReportEnabled: true, dailyReportGroupIds: ['g1'] };
    db.users = [...db.users, person('ana', 'Ana Pérez'), person('beto', 'Beto Soto'), person('caro', 'Caro Díaz')];
    db.groups = [group('g1', 'Terreno', ['ana', 'beto'])];
    db.dailyReports = [
      {
        id: 'beto_2026-11-13',
        uid: 'beto',
        date: '2026-11-13',
        text: '- Visité Maipú.',
        source: 'audio',
        transcript: 'Hoy fui a Maipú.',
        createdAt: NOW - 600_000,
        updatedAt: NOW - 600_000,
      },
    ];
    renderApp(backendOf(db, ADMIN));
    expect(await screen.findByText('1 de 2 personas enviaron su minuta.')).toBeInTheDocument();
    const rows = within(screen.getByRole('heading', { name: /Minutas del viernes 13 de noviembre/ }).closest('section')!).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Beto Soto');
    expect(rows[0]).toHaveTextContent('Enviada 18:20 · por audio');
    expect(rows[0]).toHaveTextContent('- Visité Maipú.');
    expect(rows[0]).toHaveTextContent('Hoy fui a Maipú.');
    expect(rows[1]).toHaveTextContent('Ana Pérez');
    expect(rows[1]).toHaveTextContent('Sin minuta');
    expect(screen.queryByText('Caro Díaz')).not.toBeInTheDocument();
  });
});
