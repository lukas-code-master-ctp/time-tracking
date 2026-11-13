import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile, WithId } from '@timetracking/shared';
import { Root } from '../src/Root';
import { draftErrorMessage } from '../src/pages/FieldPage';
import { ADMIN, emptyDb, fakeAuth, fakeData, type FakeDb } from './fakes';

// Friday 2026-11-13, 18:30 in Santiago.
const NOW = Date.UTC(2026, 10, 13, 21, 30);

const ANA: WithId<UserProfile> = {
  id: 'ana',
  email: 'ana@impulseai.cl',
  displayName: 'Ana Pérez',
  photoURL: null,
  role: 'member',
  status: 'active',
  createdAt: 1,
};
const terreno = { id: 'terreno', name: 'Terreno', memberUids: ['ana'], createdAt: 1, createdBy: 'admin', updatedAt: 1, updatedBy: 'admin' };

function renderField(db: FakeDb, profile: WithId<UserProfile> | null = ANA) {
  const data = fakeData(db);
  const auth = fakeAuth(profile ? { uid: profile.id, email: profile.email, displayName: profile.displayName } : null, profile ?? ANA);
  render(
    <MemoryRouter initialEntries={['/terreno']}>
      <Root getBackend={() => ({ data, auth })} />
    </MemoryRouter>,
  );
  return { data, auth };
}

function dbWith(over: Partial<FakeDb> = {}): FakeDb {
  return {
    ...emptyDb(),
    config: { allowedDomains: ['impulseai.cl'], dailyReportEnabled: true, dailyReportGroupIds: ['terreno'] } as FakeDb['config'],
    groups: [terreno],
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('phone page of the field (/terreno)', () => {
  it('asks to sign in with the field copy', async () => {
    renderField(dbWith(), null);
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
    expect(screen.getByText('Entra con tu correo de la empresa para enviar la minuta de tu día.')).toBeInTheDocument();
  });

  it('lets a member (not only admins) write and send the report', async () => {
    const db = dbWith();
    const { data } = renderField(db);
    expect(await screen.findByRole('heading', { name: 'Hola, Ana' })).toBeInTheDocument();
    expect(screen.getByText('viernes 13 de noviembre')).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText('Minuta'), '- Visité Maipú.');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar minuta' }));
    expect(await screen.findByText('¡Gracias! Tu minuta se envió.')).toBeInTheDocument();
    expect(data.putDailyReport).toHaveBeenCalledWith(
      'ana_2026-11-13',
      expect.objectContaining({ uid: 'ana', date: '2026-11-13', text: '- Visité Maipú.', source: 'text', transcript: null }),
    );
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeInTheDocument();
  });

  it("shows today's report when it was already sent", async () => {
    renderField(
      dbWith({
        dailyReports: [
          { id: 'ana_2026-11-13', uid: 'ana', date: '2026-11-13', text: '- Ya enviada.', source: 'audio', transcript: 'Hoy...', createdAt: NOW - 1000, updatedAt: NOW - 1000 },
        ],
      }),
    );
    expect(await screen.findByText('Ya enviaste la minuta de hoy. Puedes corregirla y guardar los cambios.')).toBeInTheDocument();
    expect(screen.getByLabelText('Minuta')).toHaveValue('- Ya enviada.');
    expect(screen.getByText('Ver transcripción del audio')).toBeInTheDocument();
  });

  it('tells people outside the groups that nothing is pending', async () => {
    renderField(dbWith({ groups: [{ ...terreno, memberUids: ['otro'] }] }));
    expect(await screen.findByRole('heading', { name: 'No tienes minuta pendiente' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar minuta' })).not.toBeInTheDocument();
  });

  it('refuses an empty report', async () => {
    const { data } = renderField(dbWith());
    await userEvent.click(await screen.findByRole('button', { name: 'Enviar minuta' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Graba un audio o escribe tu minuta antes de enviarla.');
    expect(data.putDailyReport).not.toHaveBeenCalled();
  });
});

describe('draftErrorMessage', () => {
  it("uses the function's own message", () => {
    const err = Object.assign(new Error('Llegaste al máximo de audios de hoy. Escribe la minuta.'), { code: 'functions/resource-exhausted' });
    expect(draftErrorMessage(err)).toBe('Llegaste al máximo de audios de hoy. Escribe la minuta.');
    expect(draftErrorMessage(Object.assign(new Error('internal'), { code: 'functions/internal' }))).toContain('No se pudo transcribir');
    expect(draftErrorMessage(Object.assign(new Error('x'), { code: 'functions/deadline-exceeded' }))).toContain('tardó demasiado');
  });
});

describe('people in the field use the normal sign-in', () => {
  it('opens the daily report page at / for a collaborator marked Terreno', async () => {
    const db = dbWith({ groups: [] });
    const fabi = { ...ANA, id: 'fabi', email: 'fabi@impulseai.cl', displayName: 'Fabiola Soto', workplace: 'field' as const };
    const data = fakeData(db);
    const auth = fakeAuth({ uid: fabi.id, email: fabi.email, displayName: fabi.displayName }, fabi);
    render(
      <MemoryRouter initialEntries={['/']}>
        <Root getBackend={() => ({ data, auth })} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Hola, Fabiola' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Enviar minuta' })).toBeInTheDocument();
  });

  it('keeps "Sin acceso" for office collaborators', async () => {
    const data = fakeData(dbWith());
    const auth = fakeAuth({ uid: ANA.id, email: ANA.email, displayName: ANA.displayName }, ANA);
    render(
      <MemoryRouter initialEntries={['/']}>
        <Root getBackend={() => ({ data, auth })} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Sin acceso' })).toBeInTheDocument();
  });

  it('lets an admin mark a collaborator as Terreno', async () => {
    const db = { ...emptyDb(), users: [ADMIN, ANA] };
    const data = fakeData(db);
    const auth = fakeAuth({ uid: ADMIN.id, email: ADMIN.email, displayName: ADMIN.displayName }, ADMIN);
    render(
      <MemoryRouter initialEntries={['/colaboradores']}>
        <Root getBackend={() => ({ data, auth })} />
      </MemoryRouter>,
    );
    await userEvent.selectOptions(await screen.findByLabelText('Lugar de trabajo de Ana Pérez'), 'field');
    expect(data.setWorkplace).toHaveBeenCalledWith('ana', 'field');
    expect(await screen.findByText(/Ana Pérez ahora es de terreno/)).toBeInTheDocument();
    // Admins have no office/field choice.
    expect(screen.queryByLabelText(`Lugar de trabajo de ${ADMIN.displayName}`)).not.toBeInTheDocument();
  });
});
