import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi, Backend } from '../src/data/types';
import { Root } from '../src/Root';
import { ADMIN, emptyDb, fakeAuth, fakeData } from './fakes';

function setup(patch: Partial<AuthApi> = {}) {
  const auth = { ...fakeAuth(null, ADMIN), ...patch };
  const backend: Backend = { auth, data: fakeData(emptyDb()) };
  render(
    <MemoryRouter initialEntries={['/']}>
      <Root getBackend={() => backend} />
    </MemoryRouter>,
  );
  return auth;
}

describe('login', () => {
  it('is always light and offers Google and email', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Inicia sesión' })).toBeInTheDocument();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Continuar con Google' })).toBeInTheDocument();
    expect(screen.getByLabelText('Correo de la empresa')).toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña')).toBeInTheDocument();
  });

  it('signs in with email and password', async () => {
    const user = userEvent.setup();
    const auth = setup();
    await user.type(await screen.findByLabelText('Correo de la empresa'), 'lukas@impulseai.cl');
    await user.type(screen.getByLabelText('Contraseña'), 'secreta123');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(auth.signInWithPassword).toHaveBeenCalledWith('lukas@impulseai.cl', 'secreta123');
  });

  it('rejects other domains before calling Firebase', async () => {
    const user = userEvent.setup();
    const auth = setup();
    await user.type(await screen.findByLabelText('Correo de la empresa'), 'alguien@gmail.com');
    await user.type(screen.getByLabelText('Contraseña'), 'secreta123');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Usa tu correo de la empresa');
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('shows a clear message for a wrong password', async () => {
    const user = userEvent.setup();
    setup({ signInWithPassword: vi.fn(async () => Promise.reject({ code: 'auth/invalid-credential' })) });
    await user.type(await screen.findByLabelText('Correo de la empresa'), 'lukas@impulseai.cl');
    await user.type(screen.getByLabelText('Contraseña'), 'mala12345');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El correo o la contraseña no coinciden');
  });

  it('asks to confirm the email when the account is not verified', async () => {
    const user = userEvent.setup();
    setup({ signInWithPassword: vi.fn(async () => 'verification-sent' as const) });
    await user.type(await screen.findByLabelText('Correo de la empresa'), 'lukas@impulseai.cl');
    await user.type(screen.getByLabelText('Contraseña'), 'secreta123');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByRole('status')).toHaveTextContent('confirma tu correo');
  });

  it('sends the reset link from "¿Olvidaste tu contraseña?"', async () => {
    const user = userEvent.setup();
    const auth = setup();
    await user.click(await screen.findByRole('button', { name: '¿Olvidaste tu contraseña?' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Recupera tu contraseña' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Correo de la empresa'), 'lukas@impulseai.cl');
    await user.click(screen.getByRole('button', { name: 'Enviar enlace' }));
    expect(auth.sendPasswordReset).toHaveBeenCalledWith('lukas@impulseai.cl');
    expect(await screen.findByRole('status')).toHaveTextContent('te llegará un enlace');
    expect(screen.getByRole('heading', { level: 1, name: 'Inicia sesión' })).toBeInTheDocument();
  });

  it('creates a password account with at least 8 characters', async () => {
    const user = userEvent.setup();
    const auth = setup();
    await user.click(await screen.findByRole('button', { name: 'Crea tu contraseña' }));
    await user.type(screen.getByLabelText('Correo de la empresa'), 'lukas@impulseai.cl');
    await user.type(screen.getByLabelText('Contraseña nueva'), 'corta');
    await user.click(screen.getByRole('button', { name: 'Crear contraseña' }));
    expect(auth.createPasswordAccount).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Contraseña nueva'));
    await user.type(screen.getByLabelText('Contraseña nueva'), 'larga12345');
    await user.click(screen.getByRole('button', { name: 'Crear contraseña' }));
    expect(auth.createPasswordAccount).toHaveBeenCalledWith('lukas@impulseai.cl', 'larga12345');
    expect(await screen.findByRole('status')).toHaveTextContent('Cuenta creada');
  });
});
