import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { BackendProvider } from '../src/data/context';
import type { Backend } from '../src/data/types';
import { ADMIN, backendOf, emptyDb, member, type FakeDb } from './fakes';

// Spec 2026-11-13-grupos-y-comunicados-agendados.
function renderApp(backend: Backend, path = '/colaboradores/grupos') {
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
  d.groups = [
    { id: 'g1', name: 'Terreno', memberUids: ['ana', 'old'], createdAt: 1, createdBy: ADMIN.id, updatedAt: 1, updatedBy: ADMIN.id },
  ];
  return d;
}

describe('Grupos page', () => {
  it('lists the groups with their active members', async () => {
    renderApp(backendOf(db(), ADMIN));
    const item = (await screen.findByText('Terreno')).closest('li')!;
    expect(within(item).getByText('Ana Rojas')).toBeTruthy();
    expect(within(item).getByText('1 persona')).toBeTruthy();
  });

  it('creates a group with the chosen people', async () => {
    const d = db();
    renderApp(backendOf(d, ADMIN));
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo grupo' }));
    const dialog = screen.getByRole('dialog', { name: 'Nuevo grupo' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    expect(within(dialog).getByText('Ponle un nombre al grupo.')).toBeTruthy();
    expect(within(dialog).getByText('Elige al menos una persona.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Nombre'), 'terreno');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Beto Soto/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    expect(within(dialog).getByText('Ya hay un grupo con ese nombre.')).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText('Nombre'));
    await userEvent.type(within(dialog).getByLabelText('Nombre'), 'Jefaturas');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));
    expect(await screen.findByText('Grupo «Jefaturas» creado.')).toBeTruthy();
    const created = d.groups!.find((g) => g.name === 'Jefaturas')!;
    expect(created.memberUids).toEqual(['beto']);
    expect(created.createdBy).toBe(ADMIN.id);
  });

  it('edits a group and keeps the disabled members', async () => {
    const d = db();
    renderApp(backendOf(d, ADMIN));
    await userEvent.click(await screen.findByRole('button', { name: 'Editar «Terreno»' }));
    const dialog = screen.getByRole('dialog', { name: 'Editar grupo' });
    expect((within(dialog).getByRole('checkbox', { name: /Ana Rojas/ }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Beto Soto/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Grupo «Terreno» actualizado.')).toBeTruthy();
    expect(d.groups![0]!.memberUids).toEqual(['ana', 'beto', 'old']);
    expect(d.groups![0]!.createdAt).toBe(1);
  });

  it('deletes a group after confirming', async () => {
    const d = db();
    renderApp(backendOf(d, ADMIN));
    await userEvent.click(await screen.findByRole('button', { name: 'Eliminar «Terreno»' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Eliminar grupo' })).getByRole('button', { name: 'Eliminar' }));
    expect(await screen.findByText('Aún no hay grupos')).toBeTruthy();
    expect(d.groups).toEqual([]);
  });
});
