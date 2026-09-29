/**
 * Popup (spec 8). All logic lives in the service worker; the popup only
 * exchanges typed messages with it and renders one of these states:
 *
 * - signed out → "Iniciar sesión con Google" (dev build: email of the emulator)
 * - joinOrg rejected (no invitation, other domain, disabled…) → message + retry / other account
 * - notice not accepted → link to the consent page (opened automatically after signing in)
 * - ready → start/stop the work day, live timer, today's hours and activity,
 *   what is being measured, pending uploads, sign out.
 */
import '../ui/base.css';
import './popup.css';
import type { PopupRequest, StatusView } from '../messages';
import { clock, el, hoursMinutes, percent, send } from '../ui/dom';

const root = document.getElementById('app') as HTMLElement;
let busy = false;
let lastError: string | null = null;
let lastRendered = '';
let current: StatusView | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function openConsent(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('consent.html') });
}

async function act(req: PopupRequest): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  const res = await send(req);
  busy = false;
  lastError = res.ok ? null : res.error;
  if (res.status) current = res.status;
  lastRendered = key();
  render();
  if (!res.status) void refresh();
  // After signing in (or trying to start without it), go straight to the notice.
  const signedIn = req.type === 'auth.signIn' || (__APP_ENV__ === 'dev' && req.type === 'auth.devSignIn');
  if ((res.ok && signedIn && res.status.consentRequired) || (!res.ok && res.reason === 'consent-required')) {
    openConsent();
  }
}

function key(): string {
  return JSON.stringify([current, lastError, busy]);
}

/** Re-renders only when something changed (keeps a half-typed email intact). */
async function refresh(): Promise<void> {
  const res = await send({ type: 'status' });
  if (res.status) current = res.status;
  if (!res.ok) lastError = res.error;
  const k = key();
  if (k === lastRendered) return;
  lastRendered = k;
  render();
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { type: 'button', className: `btn ${className}`, textContent: label, disabled: busy });
  b.addEventListener('click', onClick);
  return b;
}

function logo(size: 28 | 48): HTMLImageElement {
  return el('img', { src: `icons/icon-${size === 28 ? 32 : 48}.png`, alt: '', width: size, height: size });
}

function render(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const s = current;
  root.replaceChildren();
  if (!s) {
    root.append(el('p', { className: 'loading', textContent: busy ? 'Procesando…' : 'Cargando…' }));
    return;
  }
  if (s.notice) root.append(el('div', { className: 'banner warn', textContent: s.notice }));
  if (lastError) root.append(el('div', { className: 'banner error', role: 'alert', textContent: lastError }));

  if (!s.user) return renderSignedOut(s);
  if (!s.profile) return renderNotJoined(s);
  if (s.consentRequired) return renderConsent(s);
  renderReady(s);
}

function renderSignedOut(s: StatusView): void {
  const hero = el('section', { className: 'card hero' }, [
    logo(48),
    el('h1', { textContent: 'Registro de jornada' }),
    el('p', {
      className: 'muted',
      textContent: 'Inicia sesión con tu cuenta Google de la empresa para registrar tu jornada.',
    }),
  ]);
  if (__APP_ENV__ === 'dev' && s.appEnv === 'dev') {
    const input = el('input', { type: 'email', placeholder: 'correo@compratuparcela.cl', required: true, id: 'email' });
    const form = el('form', { className: 'stack' }, [
      el('label', { htmlFor: 'email', textContent: 'Correo (login de desarrollo)' }),
      input,
      el('button', { type: 'submit', className: 'btn primary', textContent: 'Entrar (emulador)', disabled: busy }),
    ]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void act({ type: 'auth.devSignIn', email: input.value });
    });
    hero.append(form);
  } else {
    hero.append(button('Iniciar sesión con Google', 'primary big', () => void act({ type: 'auth.signIn' })));
  }
  root.append(hero);
}

const JOIN_TITLES: Record<string, string> = {
  'no-invitation': 'Aún no tienes invitación',
  'invitation-revoked': 'Invitación revocada',
  'domain-not-allowed': 'Cuenta no permitida',
  'user-disabled': 'Cuenta desactivada',
  'email-not-verified': 'Correo sin verificar',
  'no-email': 'Cuenta sin correo',
};

function renderNotJoined(s: StatusView): void {
  const reason = s.joinError?.reason ?? '';
  const title = s.joinError ? (JOIN_TITLES[reason] ?? 'No se pudo validar tu cuenta') : 'Validando tu cuenta…';
  root.append(
    el('section', { className: 'card hero' }, [
      logo(48),
      el('h1', { textContent: title }),
      el('p', { className: 'muted', textContent: s.joinError?.message ?? 'Un momento, por favor.' }),
      el('p', { className: 'small muted', textContent: s.user?.email ?? '' }),
      el('div', { className: 'stack' }, [
        button('Reintentar', 'primary', () => void act({ type: 'auth.refreshProfile' })),
        button('Cerrar sesión', '', () => void act({ type: 'auth.signOut' })),
      ]),
    ]),
  );
}

function renderConsent(s: StatusView): void {
  root.append(
    el('section', { className: 'card hero' }, [
      logo(48),
      el('h1', { textContent: 'Antes de empezar' }),
      el('p', {
        className: 'muted',
        textContent: 'Lee qué mide esta extensión (y qué no) y acepta el aviso para poder iniciar tu jornada.',
      }),
      button('Leer y aceptar el aviso', 'primary big', openConsent),
      el('p', { className: 'small muted', textContent: s.user?.email ?? '' }),
      button('Cerrar sesión', '', () => void act({ type: 'auth.signOut' })),
    ]),
  );
}

function renderReady(s: StatusView): void {
  const on = s.session !== null;
  root.append(
    el('header', { className: 'top' }, [
      logo(28),
      el('div', { className: 'who' }, [
        el('strong', { textContent: s.profile?.displayName || 'Registro de jornada' }),
        el('span', { className: 'small muted', textContent: s.user?.email ?? '' }),
      ]),
      el('span', { className: `pill${on ? ' on' : ''}`, textContent: on ? 'EN JORNADA' : 'FUERA DE JORNADA' }),
    ]),
  );

  // Timer + big button
  const value = el('div', { className: 'value', textContent: on ? clock(Date.now() - s.session!.startedAt) : '0:00:00' });
  const card = el('section', { className: 'card timer' }, [
    value,
    el('div', { className: 'label small muted', textContent: on ? 'Jornada en curso' : 'Jornada no iniciada' }),
    on
      ? button('Cerrar jornada', 'stop big', () => void act({ type: 'session.stop' }))
      : button('Iniciar jornada', 'start big', () => void act({ type: 'session.start' })),
  ]);
  if (on) {
    const startedAt = s.session!.startedAt;
    timer = setInterval(() => {
      value.textContent = clock(Date.now() - startedAt);
    }, 1000);
  }
  root.append(card);

  // Today
  root.append(
    el('section', { className: 'stats' }, [
      el('div', { className: 'card stat' }, [
        el('div', { className: 'small muted', textContent: 'Horas de hoy' }),
        el('div', { className: 'value', textContent: hoursMinutes(s.today.trackedSeconds) }),
      ]),
      el('div', { className: 'card stat' }, [
        el('div', { className: 'small muted', textContent: 'Actividad de hoy' }),
        el('div', { className: 'value', textContent: percent(s.today.activeSeconds, s.today.trackedSeconds) }),
      ]),
    ]),
  );

  // What is measured (spec 4)
  const yes = (t = 'Sí') => el('span', { className: 'yes', textContent: `✓ ${t}` });
  const no = (t = 'No') => el('span', { className: 'no', textContent: t });
  const cap = s.capture;
  root.append(
    el('section', { className: 'card measure' }, [
      el('h2', { textContent: 'Qué se mide' }),
      el('ul', {}, [
        el('li', {}, [el('span', { textContent: 'Actividad (teclado/mouse)' }), yes()]),
        el('li', {}, [el('span', { textContent: 'Sitios web y tiempo fuera de Chrome' }), yes()]),
        el('li', {}, [el('span', { textContent: 'Capturas de la pestaña visible' }), cap?.screenshots ? yes() : no()]),
        cap?.screenshots
          ? el('li', {}, [el('span', { textContent: 'Capturas difuminadas' }), cap.blur ? yes() : no()])
          : null,
      ]),
      el('p', { className: 'small muted foot' }, [
        on ? 'Se mide solo mientras tu jornada está iniciada. ' : 'Ahora no se está midiendo nada. ',
        (() => {
          const l = el('button', { type: 'button', className: 'link', textContent: 'Ver aviso' });
          l.addEventListener('click', openConsent);
          return l;
        })(),
      ]),
    ]),
  );

  // Footer: sync + sign out
  const pending = s.pendingOps + s.pendingScreenshots;
  const syncText =
    pending > 0 ? `${pending} envío(s) pendiente(s)` : s.lastSyncOkAt ? 'Todo enviado' : 'Sin envíos pendientes';
  const out = el('button', {
    type: 'button',
    className: 'link',
    textContent: 'Cerrar sesión',
    disabled: busy || on,
    title: on ? 'Cierra tu jornada antes de cerrar sesión' : '',
  });
  out.addEventListener('click', () => void act({ type: 'auth.signOut' }));
  const sync = el('span', { className: `sync${pending > 0 ? ' pending' : ''}`, textContent: syncText });
  if (pending > 0) {
    sync.title = 'Se enviarán automáticamente cuando haya conexión';
  }
  root.append(el('footer', { className: 'footer muted' }, [sync, out]));
}

void refresh();
// Keep the view fresh (pending uploads, today's totals, auto-close notices).
setInterval(() => {
  if (!busy) void refresh();
}, 2_000);
