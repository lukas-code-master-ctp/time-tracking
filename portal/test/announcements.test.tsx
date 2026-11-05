import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { BackendProvider } from '../src/data/context';
import type { Backend } from '../src/data/types';
import { ADMIN, backendOf, emptyDb, member, type FakeDb } from './fakes';

// Spec 2026-11-05-comunicados.
function renderApp(backend: Backend, path = '/comunicados') {
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
  d.users = [ADMIN, member('ana', 'Ana Rojas'), member('beto', 'Beto Soto'), member('old', 'Ex Persona', { status: 'disabled' })];
  d.announcements = [
    {
      id: 'n1',
      title: 'Nuevo reglamento interno',
      body: 'Lee el reglamento.\nGracias.',
      authorName: 'Recursos Humanos',
      createdAt: Date.now() - 3_600_000,
      createdBy: ADMIN.id,
      archivedAt: null,
    },
  ];
  d.announcementReads = [{ announcementId: 'n1', uid: 'ana', readAt: Date.now() - 600_000 }];
  return d;
}

describe('Comunicados page', () => {
  it('shows who read each announcement among the active people', async () => {
    const backend = backendOf(db(), ADMIN);
    renderApp(backend);
    const item = (await screen.findByText('Nuevo reglamento interno')).closest('li')!;
    expect(within(item).getByText('Leído por 1 de 3')).toBeTruthy();
    await userEvent.click(within(item).getByRole('button', { name: 'Ver lecturas' }));
    const panel = within(item).getByRole('region', { name: 'Lecturas de «Nuevo reglamento interno»' });
    expect(within(panel).getByText('Leyeron (1)')).toBeTruthy();
    expect(within(panel).getByText('Ana Rojas')).toBeTruthy();
    expect(within(panel).getByText('Pendientes (2)')).toBeTruthy();
    expect(within(panel).getByText('Beto Soto')).toBeTruthy();
    expect(within(panel).queryByText('Ex Persona')).toBeNull();
  });

  it('publishes after confirming, with the admin as creator', async () => {
    const d = db();
    const backend = backendOf(d, ADMIN);
    renderApp(backend);
    await screen.findByText('Nuevo reglamento interno');
    await userEvent.click(screen.getByRole('button', { name: 'Publicar' }));
    expect(screen.getByText('Escribe un título.')).toBeTruthy();
    expect(backend.data.createAnnouncement).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Título'), 'Cierre de fin de año');
    await userEvent.type(screen.getByLabelText('Mensaje'), 'El 31 de diciembre la oficina cierra a las 14:00.');
    await userEvent.click(screen.getByRole('button', { name: 'Publicar' }));
    const dialog = screen.getByRole('dialog', { name: 'Publicar comunicado' });
    expect(within(dialog).getByText(/3 personas activas/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText(/Comunicado publicado/)).toBeTruthy();
    expect(d.announcements!.find((a) => a.title === 'Cierre de fin de año')).toMatchObject({
      body: 'El 31 de diciembre la oficina cierra a las 14:00.',
      authorName: 'Recursos Humanos',
      createdBy: ADMIN.id,
      archivedAt: null,
    });
    expect(await screen.findByText('Cierre de fin de año')).toBeTruthy();
  });

  it('archives, brings back and deletes', async () => {
    const d = db();
    const backend = backendOf(d, ADMIN);
    renderApp(backend);
    const item = (await screen.findByText('Nuevo reglamento interno')).closest('li')!;
    await userEvent.click(within(item).getByRole('button', { name: 'Archivar' }));
    expect(await within(item).findByText('Archivado')).toBeTruthy();
    expect(d.announcements![0]!.archivedAt).toEqual(expect.any(Number));
    await userEvent.click(within(item).getByRole('button', { name: 'Mostrar de nuevo' }));
    await within(item).findByRole('button', { name: 'Archivar' });
    expect(d.announcements![0]!.archivedAt).toBeNull();

    await userEvent.click(within(item).getByRole('button', { name: 'Eliminar «Nuevo reglamento interno»' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Eliminar comunicado' })).getByRole('button', { name: 'Eliminar' }));
    expect(await screen.findByText('Aún no hay comunicados')).toBeTruthy();
    expect(d.announcements).toEqual([]);
  });

  it('is in the menu', async () => {
    renderApp(backendOf(db(), ADMIN), '/');
    expect(await screen.findByRole('link', { name: 'Comunicados' })).toBeTruthy();
  });
});
