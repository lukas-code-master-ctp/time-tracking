import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { BackendProvider } from '../src/data/context';
import type { Backend } from '../src/data/types';
import { ADMIN, backendOf, emptyDb } from './fakes';

// Friday 2026-11-13, 10:00 in Santiago (week 2026-W46).
const NOW = Date.UTC(2026, 10, 13, 13, 0);

function renderApp(backend: Backend, path = '/comentarios') {
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

describe('Comentarios anónimos', () => {
  it('lists the comments by week, newest first, and filters by tone', async () => {
    const db = emptyDb();
    db.feedback = [
      { id: 'b', week: '2026-W46', tone: 'negative', text: 'Se cayó la VPN' },
      { id: 'a', week: '2026-W46', tone: 'positive', text: 'Gran almuerzo de equipo' },
      { id: 'c', week: '2026-W44', tone: 'positive', text: 'Buena capacitación' },
      { id: 'old', week: '2026-W20', tone: 'negative', text: 'Muy antiguo' },
    ];
    renderApp(backendOf(db, ADMIN));
    const week46 = await screen.findByRole('region', { name: 'Semana 9–15 nov' });
    expect(within(week46).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Gran almuerzo de equipo'),
      expect.stringContaining('Se cayó la VPN'),
    ]);
    expect(screen.getByRole('region', { name: 'Semana 26 oct – 1 nov' })).toHaveTextContent('Buena capacitación');
    expect(screen.queryByText('Muy antiguo')).not.toBeInTheDocument();
    expect(screen.getByText('Comentarios, últimas 4 semanas').parentElement).toHaveTextContent('3');

    await userEvent.click(screen.getByRole('button', { name: 'Algo por mejorar' }));
    expect(screen.getByText('Se cayó la VPN')).toBeInTheDocument();
    expect(screen.queryByText('Gran almuerzo de equipo')).not.toBeInTheDocument();
  });

  it('deletes a comment after confirming', async () => {
    const db = emptyDb();
    db.feedback = [{ id: 'a', week: '2026-W46', tone: 'negative', text: 'Comentario ofensivo' }];
    renderApp(backendOf(db, ADMIN));
    await userEvent.click(await screen.findByRole('button', { name: 'Eliminar' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    expect(await screen.findByText('Sin comentarios')).toBeInTheDocument();
    expect(db.feedback).toEqual([]);
  });

  it('turns the comments on, keeping the rest of config/org', async () => {
    const db = emptyDb();
    db.config = {
      allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
      screenshotsEnabled: true,
      blurScreenshots: false,
      screenshotRetentionDays: 30,
      moodPulseEnabled: true,
      updatedAt: 1,
      updatedBy: 'x',
    };
    renderApp(backendOf(db, ADMIN));
    await userEvent.click(await screen.findByLabelText(/Permitir comentarios anónimos/));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText(/Configuración guardada/)).toBeInTheDocument();
    expect(db.config).toMatchObject({ feedbackEnabled: true, moodPulseEnabled: true, screenshotRetentionDays: 30 });
  });
});
