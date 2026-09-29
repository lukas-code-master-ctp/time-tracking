/**
 * Consent page (spec 4): explains what is measured and what is not, and
 * records the acceptance (`consentAcceptedAt` + `consentVersion` in
 * `users/{uid}`) through the service worker. The notice text is static in
 * consent.html; this script only shows the current screenshot settings and
 * handles the button.
 */
import '../ui/base.css';
import './consent.css';
import { CONSENT_VERSION } from '@timetracking/shared';
import type { StatusView } from '../messages';
import { send } from '../ui/dom';

const acceptBtn = document.getElementById('accept') as HTMLButtonElement;
const statusBox = document.getElementById('status') as HTMLElement;
const captureState = document.getElementById('capture-state') as HTMLElement;
(document.getElementById('version') as HTMLElement).textContent = CONSENT_VERSION;

function show(kind: 'warn' | 'error' | 'ok', text: string): void {
  statusBox.hidden = false;
  statusBox.className = `banner ${kind}`;
  statusBox.textContent = text;
}

function renderCapture(s: StatusView): void {
  if (!s.capture) {
    captureState.textContent = 'La configuración actual se mostrará cuando inicies sesión.';
  } else if (!s.capture.screenshots) {
    captureState.textContent = 'Actualmente tu empresa tiene las capturas desactivadas.';
  } else {
    captureState.textContent = s.capture.blur
      ? 'Actualmente tu empresa tiene las capturas activadas y difuminadas.'
      : 'Actualmente tu empresa tiene las capturas activadas, sin difuminar.';
  }
}

function render(s: StatusView | undefined, error?: string): void {
  acceptBtn.disabled = true;
  if (!s) {
    show('error', error ?? 'No se pudo conectar con la extensión. Cierra esta página y vuelve a abrirla.');
    return;
  }
  renderCapture(s);
  if (!s.user) {
    show('warn', 'Primero inicia sesión desde el ícono de la extensión en la barra de Chrome.');
  } else if (!s.profile) {
    show('warn', s.joinError?.message ?? 'Tu cuenta aún no está habilitada. Pide a tu administrador que te invite.');
  } else if (!s.consentRequired) {
    show('ok', 'Ya aceptaste este aviso. Puedes iniciar tu jornada desde el ícono de la extensión.');
    acceptBtn.textContent = 'Aviso aceptado';
  } else {
    statusBox.hidden = true;
    acceptBtn.disabled = false;
  }
  if (error) show('error', error);
}

acceptBtn.addEventListener('click', async () => {
  acceptBtn.disabled = true;
  acceptBtn.textContent = 'Guardando…';
  const res = await send({ type: 'consent.accept', version: CONSENT_VERSION });
  acceptBtn.textContent = 'Acepto y entiendo';
  if (res.ok) {
    render(res.status);
    show('ok', '¡Listo! Ya puedes iniciar tu jornada desde el ícono de la extensión en la barra de Chrome.');
  } else {
    render(res.status, res.error);
  }
});

void send({ type: 'status' }).then((res) => render(res.status, res.ok ? undefined : res.error));
