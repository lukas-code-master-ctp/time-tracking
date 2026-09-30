import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '../src/data/types';
import { PRIVACY_CONTACT, PRIVACY_UPDATED_AT } from '../src/pages/PrivacyPage';
import { Root } from '../src/Root';
import { ADMIN, backendOf, emptyDb, fakeAuth, fakeData } from './fakes';

function renderRoot(path: string, getBackend: () => Backend) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Root getBackend={getBackend} />
    </MemoryRouter>,
  );
}

describe('/privacidad', () => {
  it('renders without a session and without creating the backend', () => {
    const getBackend = vi.fn((): Backend => {
      throw new Error('Firebase no configurado');
    });
    renderRoot('/privacidad', getBackend);
    expect(screen.getByRole('heading', { level: 1, name: 'Política de privacidad' })).toBeInTheDocument();
    expect(getBackend).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Iniciar sesión con Google' })).not.toBeInTheDocument();
    expect(document.title).toContain('Política de privacidad');
  });

  it('also answers at /privacidad.html (the prerendered file)', () => {
    const getBackend = vi.fn((): Backend => {
      throw new Error('Firebase no configurado');
    });
    renderRoot('/privacidad.html', getBackend);
    expect(screen.getByRole('heading', { level: 1, name: 'Política de privacidad' })).toBeInTheDocument();
    expect(getBackend).not.toHaveBeenCalled();
  });

  it('has the key sections and facts', () => {
    renderRoot('/privacidad', () => backendOf(emptyDb(), ADMIN));
    for (const name of [
      'Quién es responsable',
      'Cuándo se recogen datos',
      'Qué datos se recogen',
      'Qué NO se recoge',
      'Para qué se usan',
      'Dónde se guardan',
      'Quién accede',
      'Cuánto tiempo se conservan',
      'Tus derechos',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    const text = document.body.textContent ?? '';
    expect(text).toContain('Impulse AI');
    expect(text).toContain('Compra tu Parcela');
    expect(text).toContain('southamerica-west1');
    expect(text).toContain('Santiago de Chile');
    expect(text).toContain('90 días por defecto');
    expect(text).toContain('Ley 19.628');
    expect(text).toContain('Ley 21.719');
    expect(text).toContain('no se venden');
    expect(text).toContain('sin parámetros ni fragmentos');
    expect(text).toContain(PRIVACY_UPDATED_AT);
    expect(PRIVACY_UPDATED_AT).toBe('30 de septiembre de 2026');
    expect(document.querySelector('time')).toHaveAttribute('dateTime', '2026-09-30');

    const contacts = screen.getAllByRole('link', { name: PRIVACY_CONTACT });
    expect(contacts.length).toBeGreaterThan(0);
    for (const a of contacts) expect(a).toHaveAttribute('href', `mailto:${PRIVACY_CONTACT}`);

    const no = screen.getByRole('region', { name: 'Qué NO se recoge' });
    expect(within(no).getByText(/Qué teclas presionas/)).toBeInTheDocument();
    expect(within(no).getByText('Pestañas de incógnito:')).toBeInTheDocument();
    // Web meeting detection (extension 0.1.2), same terms as extension/consent.html.
    expect(within(no).getByText('El audio ni el video')).toBeInTheDocument();
    expect(no).toHaveTextContent('nunca se escuchan, graban ni envían');
    const yes = screen.getByRole('region', { name: 'Qué datos se recogen' });
    expect(within(yes).getByText('Reuniones web:')).toBeInTheDocument();
    for (const platform of ['Google Meet', 'Zoom', 'Microsoft Teams', 'Webex', 'Jitsi', 'Whereby', 'GoTo Meeting']) {
      expect(yes).toHaveTextContent(platform);
    }
    expect(yes).toHaveTextContent('si alguna está reproduciendo sonido');
    expect(yes).toHaveTextContent('no sube ni baja tu % de actividad');
    expect(yes).toHaveTextContent('aplicaciones de escritorio (fuera de Chrome) no se detectan');
    // Working hours (extension 0.2.0), same terms as extension/consent.html.
    const when = screen.getByRole('region', { name: 'Cuándo se recogen datos' });
    expect(when).toHaveTextContent('no mide nada fuera de tu horario ni durante la colación');
    expect(when).toHaveTextContent('inicio y el cierre de la jornada se guardan siempre');
    expect(no).toHaveTextContent('Nada fuera de tu horario ni en la colación');
    expect(within(yes).getByText('Tu horario laboral asignado, si tu empresa lo configura:')).toBeInTheDocument();
    expect(yes).toHaveTextContent('horario personalizado');
    expect(yes).toHaveTextContent('notificaciones locales');
    expect(screen.getByRole('region', { name: 'Cuánto tiempo se conservan' })).toHaveTextContent('no se guarda un historial de horarios');
  });

  it('the login page links to the privacy policy', async () => {
    const user = userEvent.setup();
    const backend: Backend = { data: fakeData(emptyDb()), auth: fakeAuth(null, ADMIN) };
    renderRoot('/', () => backend);
    const link = await screen.findByRole('link', { name: 'Política de privacidad' });
    expect(link).toHaveAttribute('href', '/privacidad');
    await user.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Política de privacidad' })).toBeInTheDocument();
  });

  it.each(['/privacidad/extra', '/privacidadx', '/equipo', '/'])('%s goes through the admin gate', async (path) => {
    const getBackend = vi.fn((): Backend => ({ data: fakeData(emptyDb()), auth: fakeAuth(null, ADMIN) }));
    renderRoot(path, getBackend);
    expect(await screen.findByRole('button', { name: 'Iniciar sesión con Google' })).toBeInTheDocument();
    expect(getBackend).toHaveBeenCalled();
    expect(screen.queryByRole('heading', { level: 1, name: 'Política de privacidad' })).not.toBeInTheDocument();
  });

  it('other paths still go through the admin gate', async () => {
    const getBackend = vi.fn(() => backendOf(emptyDb(), ADMIN));
    renderRoot('/configuracion', getBackend);
    expect(await screen.findByRole('heading', { name: 'Configuración' })).toBeInTheDocument();
    expect(getBackend).toHaveBeenCalled();
  });
});
