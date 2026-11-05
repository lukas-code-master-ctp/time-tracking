import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { BackendProvider } from '../src/data/context';
import type { Backend } from '../src/data/types';
import { weekLabel } from '../src/pages/MoodPage';
import { ADMIN, backendOf, emptyDb } from './fakes';

// Thursday 2026-11-05, 15:30 in Santiago (week 2026-W45).
const NOW = Date.UTC(2026, 10, 5, 18, 30);

function renderApp(backend: Backend, path = '/animo') {
  return render(
    <BackendProvider backend={backend}>
      <MemoryRouter initialEntries={[path]}>
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

describe('Pulso de ánimo', () => {
  it('labels weeks Monday to Sunday', () => {
    expect(weekLabel('2026-W45')).toBe('2–8 nov');
    expect(weekLabel('2026-W40')).toBe('28 sept – 4 oct');
  });

  it('shows the weekly averages and hides weeks with fewer than 3 answers', async () => {
    const db = emptyDb();
    db.moodWeeks = [
      { id: '2026-W45', n4: 3, n5: 1 },
      { id: '2026-W44', n2: 2 },
      { id: '2026-W43', n3: 2, n4: 2 },
    ];
    renderApp(backendOf(db, ADMIN));
    const weeks = await screen.findByRole('list', { name: 'Semanas' });
    const rows = within(weeks).getAllByRole('listitem');
    expect(rows).toHaveLength(12);
    expect(rows[0]).toHaveTextContent('2–8 nov');
    expect(rows[0]).toHaveTextContent('4,3');
    expect(rows[0]).toHaveTextContent('4 respuestas');
    expect(within(rows[0]!).getByRole('img')).toHaveAccessibleName('Bien: 3, Muy bien: 1');
    expect(rows[1]).toHaveTextContent('Menos de 3 respuestas');
    expect(rows[1]).not.toHaveTextContent('2,0');
    expect(rows[2]).toHaveTextContent('3,5');
    expect(rows[3]).toHaveTextContent('Sin respuestas');
    // Last 4 weeks together: 10 answers.
    expect(screen.getByText('Respuestas, últimas 4 semanas').parentElement).toHaveTextContent('10');
  });

  it('turns the question on, keeping the rest of config/org', async () => {
    const db = emptyDb();
    db.config = {
      allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
      screenshotsEnabled: true,
      blurScreenshots: false,
      screenshotRetentionDays: 30,
      activeBreaksEnabled: true,
      activeBreakIntervalMinutes: 60,
      activeBreakMinutes: 5,
      updatedAt: 1,
      updatedBy: 'x',
    };
    renderApp(backendOf(db, ADMIN));
    await userEvent.click(await screen.findByLabelText(/Cómo estuvo tu día/));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText(/Configuración guardada/)).toBeInTheDocument();
    expect(db.config).toMatchObject({ moodPulseEnabled: true, screenshotsEnabled: true, screenshotRetentionDays: 30, activeBreaksEnabled: true });
  });
});
