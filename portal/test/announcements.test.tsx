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
    expect(within(dialog).getByText(/3 personas \(todo el equipo\)/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText(/Comunicado publicado/)).toBeTruthy();
    expect(d.announcements!.find((a) => a.title === 'Cierre de fin de año')).toMatchObject({
      body: 'El 31 de diciembre la oficina cierra a las 14:00.',
      authorName: 'Recursos Humanos',
      createdBy: ADMIN.id,
      archivedAt: null,
      audience: ['*'],
      groupIds: [],
    });
    const created = d.announcements!.find((a) => a.title === 'Cierre de fin de año')!;
    expect(created.publishAt).toBe(created.createdAt);
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

  // Spec 2026-11-13-grupos-y-comunicados-agendados.
  function withGroups(): FakeDb {
    const d = db();
    d.groups = [
      { id: 'g1', name: 'Terreno', memberUids: ['ana'], createdAt: 1, createdBy: ADMIN.id, updatedAt: 1, updatedBy: ADMIN.id },
      { id: 'g2', name: 'Jefaturas', memberUids: ['beto', 'ana'], createdAt: 1, createdBy: ADMIN.id, updatedAt: 1, updatedBy: ADMIN.id },
    ];
    return d;
  }

  it('gives old announcements the new fields, for everyone', async () => {
    const d = db();
    renderApp(backendOf(d, ADMIN));
    const item = (await screen.findByText('Nuevo reglamento interno')).closest('li')!;
    expect(within(item).getByText(/Todo el equipo/)).toBeTruthy();
    expect(d.announcements![0]).toMatchObject({ audience: ['*'], groupIds: [], publishAt: d.announcements![0]!.createdAt });
  });

  it('schedules an announcement for some groups', async () => {
    const d = withGroups();
    renderApp(backendOf(d, ADMIN));
    await screen.findByText('Nuevo reglamento interno');
    await userEvent.type(screen.getByLabelText('Título'), 'Visita a obra');
    await userEvent.type(screen.getByLabelText('Mensaje'), 'Mañana vamos a la obra de Colina.');
    await userEvent.click(screen.getByRole('button', { name: 'Algunos grupos' }));
    await userEvent.click(screen.getByRole('button', { name: 'Publicar' }));
    expect(screen.getByText('Elige al menos un grupo.', { selector: '.field-error' })).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /Terreno/ }));
    expect(screen.getByText('Llega a 1 persona activa.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Programar' }));
    const when = screen.getByLabelText('Fecha y hora de envío') as HTMLInputElement;
    expect(when.value).toMatch(/T09:00$/);
    await userEvent.click(screen.getByRole('button', { name: 'Programar envío' }));
    const dialog = screen.getByRole('dialog', { name: 'Programar comunicado' });
    expect(within(dialog).getByText(/1 persona \(grupos: Terreno\)/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Programar' }));
    expect(await screen.findByText(/Comunicado programado para/)).toBeTruthy();
    const a = d.announcements!.find((x) => x.title === 'Visita a obra')!;
    expect(a).toMatchObject({ audience: ['ana'], groupIds: ['g1'] });
    expect(a.publishAt).toBeGreaterThan(Date.now());
    const scheduled = within(screen.getByRole('region', { name: 'Programados' }));
    expect(scheduled.getByText('Visita a obra')).toBeTruthy();
  });

  it('a past time is refused', async () => {
    renderApp(backendOf(withGroups(), ADMIN));
    await screen.findByText('Nuevo reglamento interno');
    await userEvent.type(screen.getByLabelText('Título'), 'X');
    await userEvent.type(screen.getByLabelText('Mensaje'), 'Y');
    await userEvent.click(screen.getByRole('button', { name: 'Programar' }));
    const when = screen.getByLabelText('Fecha y hora de envío');
    await userEvent.clear(when);
    await userEvent.type(when, '2020-01-01T09:00');
    await userEvent.click(screen.getByRole('button', { name: 'Programar envío' }));
    expect(screen.getByText(/ya pasó/)).toBeTruthy();
  });

  it('edits a scheduled one, sends it now, and counts reads among its recipients', async () => {
    const d = withGroups();
    const createdAt = Date.now() - 60_000;
    d.announcements = [
      {
        id: 'p1',
        title: 'Turnos de diciembre',
        body: 'Revisen los turnos.',
        authorName: 'Recursos Humanos',
        createdAt,
        createdBy: ADMIN.id,
        archivedAt: null,
        publishAt: Date.now() + 86_400_000,
        audience: ['ana'],
        groupIds: ['g1'],
      },
    ];
    renderApp(backendOf(d, ADMIN));
    await userEvent.click(await screen.findByRole('button', { name: 'Editar «Turnos de diciembre»' }));
    expect(screen.getByRole('heading', { name: 'Editar comunicado programado' })).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /Jefaturas/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Guardar cambios' })).getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByText('Cambios guardados.')).toBeTruthy();
    expect(d.announcements[0]).toMatchObject({ groupIds: ['g1', 'g2'] });
    expect([...d.announcements[0]!.audience!].sort()).toEqual(['ana', 'beto']);

    await userEvent.click(screen.getByRole('button', { name: 'Enviar ahora «Turnos de diciembre»' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Enviar ahora' })).getByRole('button', { name: 'Enviar ahora' }));
    expect(await screen.findByText(/Comunicado enviado/)).toBeTruthy();
    expect(d.announcements[0]!.publishAt).toBeLessThanOrEqual(Date.now());
    const item = (await screen.findByText('Turnos de diciembre')).closest('li')!;
    expect(within(item).getByText('Leído por 0 de 2')).toBeTruthy();
    expect(within(item).getByText(/Terreno, Jefaturas/)).toBeTruthy();
  });

  it('saving a group updates the scheduled announcements sent to it', async () => {
    const d = withGroups();
    d.announcements = [
      {
        id: 'p1',
        title: 'Turnos',
        body: 'b',
        authorName: 'RRHH',
        createdAt: 1,
        createdBy: ADMIN.id,
        archivedAt: null,
        publishAt: Date.now() + 86_400_000,
        audience: ['ana'],
        groupIds: ['g1'],
      },
      {
        id: 's1',
        title: 'Enviado',
        body: 'b',
        authorName: 'RRHH',
        createdAt: 1,
        createdBy: ADMIN.id,
        archivedAt: null,
        publishAt: 1,
        audience: ['ana'],
        groupIds: ['g1'],
      },
    ];
    renderApp(backendOf(d, ADMIN), '/colaboradores/grupos');
    await userEvent.click(await screen.findByRole('button', { name: 'Editar «Terreno»' }));
    const dialog = screen.getByRole('dialog', { name: 'Editar grupo' });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Beto Soto/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Grupo «Terreno» actualizado.')).toBeTruthy();
    expect(d.announcements.find((a) => a.id === 'p1')!.audience).toEqual(['ana', 'beto']);
    // Already sent: keeps who it went to.
    expect(d.announcements.find((a) => a.id === 's1')!.audience).toEqual(['ana']);
  });
});

describe('datetime-local in the organization zone', () => {
  it('round-trips Santiago wall-clock times, also across DST', async () => {
    const { fromLocalInput, toLocalInput, defaultScheduleTime } = await import('../src/lib/announcements');
    // 2026-11-14 09:00 in Santiago (UTC-3 in summer) = 12:00 UTC.
    expect(fromLocalInput('2026-11-14T09:00')).toBe(Date.UTC(2026, 10, 14, 12, 0));
    // Winter (UTC-4).
    expect(fromLocalInput('2026-07-01T09:00')).toBe(Date.UTC(2026, 6, 1, 13, 0));
    for (const v of ['2026-11-14T09:00', '2026-07-01T23:59', '2026-04-05T10:30', '2026-09-06T12:00']) expect(toLocalInput(fromLocalInput(v))).toBe(v);
    expect(fromLocalInput('')).toBeNaN();
    expect(fromLocalInput('2026-02-30T09:00')).toBeNaN();
    expect(toLocalInput(defaultScheduleTime(Date.UTC(2026, 10, 13, 15, 0)))).toBe('2026-11-14T09:00');
  });
});
