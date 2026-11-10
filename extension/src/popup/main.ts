/**
 * Popup (spec 8). All logic lives in the service worker; the popup only
 * exchanges typed messages with it and renders one of these states:
 *
 * - signed out → "Iniciar sesión con Google" (dev build: email of the emulator)
 * - joinOrg rejected (no invitation, other domain, disabled…) → message + retry / other account
 * - notice not accepted → link to the consent page (opened automatically after signing in)
 * - ready → start/stop the work day, live timer, working hours (state now
 *   and today's schedule, only when configured), today's hours, activity
 *   (excluding meeting time) and time in web meetings, active breaks (when
 *   the organization turned them on: pending reminder, next one, on/off for
 *   this person), internal announcements waiting for "Confirmo que lo
 *   leí" (spec 2026-11-05-comunicados), team birthdays and work
 *   anniversaries (today and the next 7 days, when recorded in the
 *   portal), what is being
 *   measured, pending uploads, sign out.
 *
 * Outside Chrome the popup closes when Google's window opens, so the result
 * of "Iniciar sesión con Google" (error or success) is read back from the
 * status (`signInResult`, kept by the worker in chrome.storage.session),
 * shown once and then cleared.
 */
import '../ui/base.css';
import './popup.css';
import type { PopupRequest, StatusView } from '../messages';
import { getTheme, nextTheme, setTheme, THEME_LABEL } from '../ui/theme';
import { clock, el, hoursMinutes, percent, send, workDayElapsed } from '../ui/dom';
import { usesGoogleAccountChooser } from '../browser';
import { ALLOWED_DOMAINS } from '../env';
import { MOOD_OPTIONS, type MoodScore } from '@timetracking/shared';

const root = document.getElementById('app') as HTMLElement;
let busy = false;
/** Request in progress (while `busy`): "Iniciar jornada" can wait up to 3 s for the schedule read. */
let inFlight: PopupRequest['type'] | null = null;
let lastError: string | null = null;
/** Success message (e.g. "Sesión iniciada como …"), shown until the next action. */
let lastInfo: string | null = null;
/** `at` of the sign-in result already shown (each one is shown once). */
let shownSignInAt: number | null = null;
let lastRendered = '';
let current: StatusView | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function openConsent(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('consent.html') });
}

async function act(req: PopupRequest): Promise<void> {
  if (busy) return;
  busy = true;
  inFlight = req.type;
  lastInfo = null;
  render();
  const res = await send(req);
  busy = false;
  inFlight = null;
  lastError = res.ok ? null : res.error;
  if (res.status) current = res.status;
  // Still open after the sign-in (Chrome): this response is the result; just
  // show it and forget the stored copy (the consent page is opened below).
  if (req.type === 'auth.signIn') takeSignInResult(res.status, false);
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
  return JSON.stringify([current, lastError, lastInfo, busy, inFlight]);
}

/**
 * Shows the stored result of the last sign-in attempt once and asks the
 * worker to clear it. `reopened`: the popup was closed during the attempt
 * (Google's window), so also open the notice the attempt would have opened.
 */
function takeSignInResult(s: StatusView | undefined, reopened: boolean): void {
  const r = s?.signInResult;
  if (!r || r.at === shownSignInAt) return;
  shownSignInAt = r.at;
  if (r.ok) {
    lastInfo = r.message;
    lastError = null;
    if (reopened && s?.consentRequired) openConsent();
  } else {
    lastError = r.message;
    lastInfo = null;
  }
  void send({ type: 'auth.clearSignInResult', at: r.at });
}

/** Re-renders only when something changed (keeps a half-typed email intact). */
async function refresh(): Promise<void> {
  const res = await send({ type: 'status' });
  if (res.status) current = res.status;
  if (!res.ok) lastError = res.error;
  takeSignInResult(res.status, true);
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

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Lucide-style outline icons (24×24) of the theme toggle. */
const THEME_ICON: Record<ReturnType<typeof getTheme>, string> = {
  system: 'M4 5h16v11H4zM8 20h8M12 16v4',
  light: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  dark: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z',
};

/** Header button: Sistema → Claro → Oscuro (kept for every extension page, see ui/theme.ts). */
function themeToggle(): HTMLButtonElement {
  const t = getTheme();
  const label = `Tema: ${THEME_LABEL[t]}. Cambiar a ${THEME_LABEL[nextTheme(t)]}`;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', THEME_ICON[t]);
  svg.append(path);
  const b = el('button', { type: 'button', id: 'theme', className: 'icon-btn', title: label, ariaLabel: label }, [svg]);
  b.addEventListener('click', () => {
    setTheme(nextTheme(getTheme()));
    render();
  });
  return b;
}

function logo(size: 28 | 48): HTMLImageElement {
  return el('img', { src: `icons/icon-${size === 28 ? 32 : 48}.png`, alt: '', width: size, height: size });
}

/**
 * Identifies the focused control so a re-render (every status change) does
 * not throw keyboard focus back to the top of the popup.
 */
function keyOf(node: HTMLElement): string {
  return node.id ? `#${node.id}` : `${node.tagName}:${node.textContent ?? ''}`;
}

/** Last control focused in the popup (kept while it is replaced by a disabled "busy" copy). */
let lastFocus: string | null = null;
root.addEventListener('focusin', (e) => {
  if (e.target instanceof HTMLElement) lastFocus = keyOf(e.target);
});
root.addEventListener('focusout', (e) => {
  // Focus moved to something else on purpose (not lost because the node was removed).
  if (e.relatedTarget instanceof HTMLElement) lastFocus = null;
});

function focusKey(): string | null {
  const a = document.activeElement;
  if (a instanceof HTMLElement && root.contains(a)) return keyOf(a);
  return lastFocus;
}

function restoreFocus(k: string | null): void {
  if (!k) return;
  for (const node of root.querySelectorAll<HTMLElement>('button, input')) {
    if (keyOf(node) === k && !(node as HTMLButtonElement).disabled) {
      node.focus();
      return;
    }
  }
}

function render(): void {
  const focused = focusKey();
  try {
    draw();
  } finally {
    restoreFocus(focused);
  }
}

function draw(): void {
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
  // No aria-live on the whole popup (the timer would be announced every second): only the banners.
  if (s.notice) root.append(el('div', { className: 'banner warn', role: 'status', textContent: s.notice }));
  if (lastError) root.append(el('div', { className: 'banner error', role: 'alert', textContent: lastError }));
  if (lastInfo && !lastError) root.append(el('div', { className: 'banner ok', role: 'status', textContent: lastInfo }));

  if (!s.user) return renderSignedOut(s);
  if (!s.profile) return renderNotJoined(s);
  if (s.consentRequired) return renderConsent(s);
  renderReady(s);
}

function renderSignedOut(s: StatusView): void {
  const hero = el('section', { className: 'card hero' }, [
    logo(48),
    el('h1', { className: 'brand-name', textContent: 'Mi Pega HR' }),
    el('p', {
      className: 'muted',
      textContent: 'Inicia sesión con tu cuenta Google de la empresa para registrar tu jornada.',
    }),
  ]);
  if (__APP_ENV__ === 'dev' && s.appEnv === 'dev') {
    const input = el('input', { type: 'email', placeholder: `correo@${ALLOWED_DOMAINS[0] ?? 'empresa.cl'}`, required: true, id: 'email' });
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
    // Outside Chrome the sign-in opens Google's account chooser (launchWebAuthFlow).
    if (usesGoogleAccountChooser()) {
      hero.append(el('p', { className: 'muted', textContent: 'Se abrirá una ventana de Google: elige tu cuenta de la empresa.' }));
    }
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

/** "Qué se mide" stays open across re-renders once the person opens it. */
let measureOpen = false;

/**
 * Layout (one thing per level): who is signed in; the work day (state, clock,
 * today's schedule, the one big action); an active break waiting for an
 * answer; today's numbers in one row; what is measured (folded); footer.
 */
function renderReady(s: StatusView): void {
  const on = s.session !== null;
  // Spec 2026-11-10-marcaciones: the work day is marked on the kiosk at the entrance.
  const kioskOnly = !on && s.attendanceMode === 'kiosk';
  root.append(
    el('header', { className: 'top' }, [
      logo(28),
      el('div', { className: 'who' }, [
        el('strong', { textContent: s.profile?.displayName || 'Mi Pega HR' }),
        el('span', { className: 'small muted', textContent: s.user?.email ?? '' }),
      ]),
      themeToggle(),
    ]),
  );

  // Work day: state + schedule, clock, today's hours, the big button.
  const pauses = s.session?.pauses ?? [];
  const paused = (now: number): boolean => pauses.some((p) => now >= p.start && now < p.end);
  const stateText = (now: number): string =>
    kioskOnly ? 'Marcas en el tótem' : !on ? 'Jornada no iniciada' : paused(now) ? 'En pausa (colación)' : 'En jornada';
  const tone = !on ? 'idle' : s.schedule && !s.schedule.measuring ? 'warn' : 'on';
  const state = el('span', { className: 'state-text', textContent: stateText(Date.now()) });
  const value = el('div', { className: 'value', textContent: on ? clock(workDayElapsed(s.session!.startedAt, Date.now(), pauses)) : '0:00:00' });
  const card = el('section', { className: `card workday ${tone}` }, [
    el('div', { className: 'status' }, [
      el('span', { className: 'dot', ariaHidden: 'true' }),
      state,
      s.schedule ? el('span', { className: 'sep', ariaHidden: 'true', textContent: '·' }) : null,
      s.schedule ? el('span', { className: 'sched-label', textContent: s.schedule.label }) : null,
    ]),
    kioskOnly ? null : value,
    s.schedule ? el('div', { className: 'small muted sched-today', textContent: s.schedule.today }) : null,
    on
      ? button('Cerrar jornada', 'stop big', () => void act({ type: 'session.stop' }))
      : kioskOnly
        ? el('p', {
            className: 'kiosk-note',
            textContent: 'Tu empresa registra tu jornada en el tótem de la oficina: marca ahí tu entrada y tu salida con tu RUT.',
          })
        : button(inFlight === 'session.start' ? 'Iniciando…' : 'Iniciar jornada', 'start big', () => void act({ type: 'session.start' })),
  ]);
  if (on) {
    const startedAt = s.session!.startedAt;
    timer = setInterval(() => {
      const now = Date.now();
      value.textContent = clock(workDayElapsed(startedAt, now, pauses));
      state.textContent = stateText(now);
    }, 1000);
  }
  root.append(card);

  if (s.announcements.length > 0) root.append(renderAnnouncement(s.announcements));

  if (!on && s.mood?.pending) root.append(renderMood());
  if (s.breaks) root.append(renderBreaks(s.breaks, on));
  if (s.celebrations.length > 0) root.append(renderCelebrations(s.celebrations));

  // Today, in one row.
  const stat = (label: string, text: string, title = ''): HTMLElement =>
    el('div', { className: 'stat', title }, [
      el('div', { className: 'stat-label', textContent: label }),
      el('div', { className: 'stat-value', textContent: text }),
    ]);
  root.append(
    el('section', { className: 'card today', ariaLabel: 'Hoy' }, [
      stat('Horas hoy', hoursMinutes(s.today.trackedSeconds)),
      stat('Actividad', percent(s.today.activeSeconds, s.today.trackedSeconds, s.today.meetingSeconds)),
      stat(
        'Reuniones',
        hoursMinutes(s.today.meetingSeconds),
        'Tiempo en reuniones web sin usar teclado ni mouse. No sube ni baja tu actividad.',
      ),
    ]),
  );

  // What is measured (spec 4): the state always visible, the list folded.
  const yes = (t = 'Sí') => el('span', { className: 'yes', textContent: t });
  const no = (t = 'No') => el('span', { className: 'no', textContent: t });
  const cap = s.capture;
  const now =
    on
      ? s.schedule && !s.schedule.measuring
        ? 'Tu jornada sigue iniciada, pero ahora no se mide nada.'
        : s.schedule
          ? 'Se mide solo con tu jornada iniciada y dentro de tu horario.'
          : 'Se mide solo mientras tu jornada está iniciada.'
      : 'Ahora no se está midiendo nada.';
  const notice = el('button', { type: 'button', className: 'link', textContent: 'Ver aviso' });
  notice.addEventListener('click', openConsent);
  const measure = el('details', { className: 'card measure', open: measureOpen }, [
    el('summary', {}, [
      el('span', { className: 'measure-title', textContent: 'Qué se mide' }),
      el('span', { className: 'small muted', textContent: now }),
    ]),
    el('ul', {}, [
      el('li', {}, [el('span', { textContent: 'Actividad (teclado/mouse)' }), yes()]),
      el('li', {}, [el('span', { textContent: 'Sitios web y tiempo fuera de Chrome' }), yes()]),
      el('li', {}, [el('span', { textContent: 'Reuniones web (Meet, Zoom, Teams…)' }), yes()]),
      el('li', {}, [el('span', { textContent: 'Capturas de la pestaña visible' }), cap?.screenshots ? yes() : no()]),
      cap?.screenshots ? el('li', {}, [el('span', { textContent: 'Capturas difuminadas' }), cap.blur ? yes() : no()]) : null,
    ]),
    el('p', { className: 'small muted foot' }, ['Detalle completo en el ', notice, '.']),
  ]);
  measure.addEventListener('toggle', () => {
    measureOpen = measure.open;
  });
  root.append(measure);

  // Footer: sync, absences, sign out.
  const pending = s.pendingOps + s.pendingScreenshots;
  const syncText =
    pending > 0 ? `${pending} por enviar` : s.lastSyncOkAt ? 'Todo enviado' : 'Sin envíos pendientes';
  const out = el('button', {
    type: 'button',
    className: 'link quiet',
    textContent: 'Cerrar sesión',
    disabled: busy || on,
    title: on ? 'Cierra tu jornada antes de cerrar sesión' : '',
  });
  out.addEventListener('click', () => void act({ type: 'auth.signOut' }));
  const sync = el('span', { className: `sync${pending > 0 ? ' pending' : ''}`, textContent: syncText });
  if (pending > 0) {
    sync.title = 'Se enviarán automáticamente cuando haya conexión';
  }
  const absences = el('button', { type: 'button', className: 'link quiet', textContent: 'Solicitar ausencia' });
  absences.addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('absences.html') }));
  root.append(el('footer', { className: 'footer small muted' }, [sync, el('span', { className: 'actions' }, [absences, out])]));
}

/** Mood pulse (spec 2026-11-05-pulso-de-animo): one click after closing the work day. */
function renderMood(): HTMLElement {
  const faces = MOOD_OPTIONS.map((o) => {
    const b = el('button', { type: 'button', className: 'mood-face', disabled: busy, title: o.label, ariaLabel: o.label }, [
      el('span', { className: 'mood-emoji', ariaHidden: 'true', textContent: o.emoji }),
      el('span', { className: 'mood-label', textContent: o.label }),
    ]);
    b.addEventListener('click', () => void answerMood(o.score));
    return b;
  });
  const skip = el('button', { type: 'button', className: 'link quiet', textContent: 'Omitir', disabled: busy });
  skip.addEventListener('click', () => void answerMood(null));
  const group = el('div', { className: 'mood-faces', role: 'group' }, faces);
  group.setAttribute('aria-labelledby', 'mood-title');
  return el('section', { className: 'card mood', role: 'status' }, [
    el('div', { className: 'mood-title', id: 'mood-title', textContent: '¿Cómo estuvo tu día?' }),
    group,
    el('div', { className: 'mood-foot small muted' }, [
      el('span', { textContent: 'Es anónimo: tu empresa solo ve el resumen semanal del equipo.' }),
      skip,
    ]),
  ]);
}

async function answerMood(score: MoodScore | null): Promise<void> {
  await act({ type: 'mood.answer', score });
  if (score !== null && !lastError) {
    lastInfo = '¡Gracias! Tu respuesta se guardó sin tu nombre.';
    lastRendered = key();
    render();
  }
}

/** "Pausa activa" (spec 2026-10-21-pausa-activa): a prompt when one is due, otherwise one quiet row. */
function renderBreaks(b: NonNullable<StatusView['breaks']>, on: boolean): HTMLElement {
  const toggle = el('input', { type: 'checkbox', id: 'breaks-enabled', checked: b.enabled, disabled: busy, role: 'switch' });
  toggle.addEventListener('change', () => void act({ type: 'breaks.setEnabled', enabled: toggle.checked }));
  const sw = el('label', { className: 'switch', htmlFor: 'breaks-enabled', title: 'Recordarme las pausas activas' }, [
    toggle,
    el('span', { className: 'sr-only', textContent: 'Recordarme las pausas activas' }),
  ]);
  if (b.pending) {
    return el('section', { className: 'card breaks due', role: 'status' }, [
      el('div', { className: 'breaks-head' }, [el('span', { className: 'eyebrow', textContent: 'Pausa activa' })]),
      el('div', { className: 'breaks-title', textContent: b.pending.title }),
      el('p', { className: 'small', textContent: b.pending.text }),
      el('div', { className: 'row' }, [
        button('Tomé la pausa', 'primary', () => void act({ type: 'breaks.answer', answer: 'taken' })),
        button('En 10 min', '', () => void act({ type: 'breaks.answer', answer: 'postponed' })),
      ]),
    ]);
  }
  const every =
    b.mode === 'daily'
      ? `${b.perDay} ${b.perDay === 1 ? 'pausa' : 'pausas'} de ${b.durationMinutes} min al día`
      : `${b.durationMinutes} min cada ${b.intervalMinutes} min de trabajo`;
  const detail = !b.enabled
    ? 'Recordatorios desactivados en este equipo'
    : on && b.nextAt !== null
      ? `Próxima cerca de las ${timeOfDay(b.nextAt)}`
      : every.charAt(0).toUpperCase() + every.slice(1);
  return el('section', { className: `card breaks${b.enabled ? '' : ' off'}` }, [
    el('div', { className: 'breaks-text', title: every.charAt(0).toUpperCase() + every.slice(1) }, [
      el('div', { className: 'breaks-name', textContent: 'Pausa activa' }),
      el('div', { className: 'small muted', textContent: detail }),
    ]),
    sw,
  ]);
}

/**
 * Internal announcement (spec 2026-11-05-comunicados): the oldest one not
 * confirmed, with "1 de 3" when more are waiting. Plain text: textContent,
 * line breaks kept by the CSS.
 */
function renderAnnouncement(list: StatusView['announcements']): HTMLElement {
  const a = list[0]!;
  const when = new Date(a.createdAt).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
  return el('section', { className: 'card announcement', ariaLabel: 'Comunicado interno' }, [
    el('div', { className: 'announcement-head' }, [
      el('span', { className: 'eyebrow', textContent: 'Comunicado' }),
      list.length > 1 ? el('span', { className: 'small muted', textContent: `1 de ${list.length}` }) : null,
    ]),
    el('div', { className: 'announcement-title', textContent: a.title }),
    el('div', { className: 'small muted', textContent: `${a.authorName} · ${when}` }),
    el('p', { className: 'small announcement-body', textContent: a.body }),
    button(inFlight === 'announcements.ack' ? 'Confirmando…' : 'Confirmo que lo leí', 'primary', () => void act({ type: 'announcements.ack', id: a.id })),
  ]);
}

type CelebrationItem = StatusView['celebrations'][number];

const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** "Hoy", "Mañana", "Vie 7". */
function celebrationDay(c: CelebrationItem): string {
  if (c.daysAway === 0) return 'Hoy';
  if (c.daysAway === 1) return 'Mañana';
  const d = new Date(Date.UTC(Number(c.date.slice(0, 4)), Number(c.date.slice(5, 7)) - 1, Number(c.date.slice(8, 10))));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

function yearsText(years: number | null): string {
  const y = years ?? 0;
  return `${y} ${y === 1 ? 'año' : 'años'}`;
}

/** One line: "Hoy es el cumpleaños de Ana", "Beto Díaz cumple 3 años en la empresa"… */
function celebrationText(c: CelebrationItem): string {
  const today = c.daysAway === 0;
  // The boss is warned the day before.
  if (c.managed && c.daysAway === 1) {
    return c.kind === 'birthday' ? `Mañana cumple años ${c.name}` : `Mañana ${c.name} cumple ${yearsText(c.years)}`;
  }
  if (c.kind === 'birthday') {
    if (c.self) return today ? '¡Feliz cumpleaños!' : 'Tu cumpleaños';
    return today ? `Hoy es el cumpleaños de ${c.name}` : `Cumpleaños de ${c.name}`;
  }
  if (c.self) return today ? `¡Feliz aniversario! ${yearsText(c.years)} en la empresa` : `Tu aniversario · ${yearsText(c.years)}`;
  return today ? `${c.name} cumple ${yearsText(c.years)} en la empresa` : `${c.name} · ${yearsText(c.years)}`;
}

function celebrationRow(c: CelebrationItem, extra: HTMLElement | null = null): HTMLElement {
  const text = celebrationText(c);
  // Upcoming anniversaries are short on screen ("Beto · 3 años"): the full sentence for the tooltip and screen readers.
  const full =
    c.managed && c.daysAway === 1
      ? c.kind === 'birthday'
        ? `Mañana ${c.name} está de cumpleaños`
        : `Mañana ${c.name} cumple ${yearsText(c.years)} en la empresa`
      : c.kind === 'anniversary' && c.daysAway > 0
        ? `${c.self ? 'Cumples' : `${c.name} cumple`} ${yearsText(c.years)} en la empresa`
        : text;
  return el('span', { className: 'cel-row' }, [
    el('span', { className: 'cel-icon', ariaHidden: 'true', textContent: c.kind === 'birthday' ? '🎂' : '🎉' }),
    el('span', { className: 'cel-text', textContent: text, title: full, ariaLabel: full }),
    c.daysAway > 0 && !(c.managed && c.daysAway === 1)
      ? el('span', {
          className: 'small muted cel-when',
          textContent: celebrationDay(c),
        })
      : null,
    extra,
  ]);
}

/** The rest of this week's celebrations stays open across re-renders once opened. */
let celebrationsOpen = false;

/**
 * Team birthdays and work anniversaries (spec 2026-11-05-cumpleanos-aniversarios):
 * one row with the soonest (highlighted when it is today); the rest of the
 * week folds under it, so the popup keeps its height.
 */
function renderCelebrations(list: StatusView['celebrations']): HTMLElement {
  const [first, ...rest] = list;
  const today = first!.daysAway === 0 || (first!.managed && first!.daysAway === 1);
  const className = `card celebrations${today ? ' has-today' : ''}`;
  if (rest.length === 0) {
    return el('section', { className, ariaLabel: 'Cumpleaños y aniversarios' }, [celebrationRow(first!)]);
  }
  const more = el('span', { className: 'cel-more', textContent: `+${rest.length}`, title: `${rest.length} más esta semana` });
  const details = el('details', { className, open: celebrationsOpen }, [
    el('summary', { ariaLabel: `Cumpleaños y aniversarios: ${celebrationText(first!)}, y ${rest.length} más esta semana` }, [
      celebrationRow(first!, more),
    ]),
    el('ul', { className: 'cel-list' }, rest.map((c) => el('li', {}, [celebrationRow(c)]))),
  ]);
  details.addEventListener('toggle', () => {
    celebrationsOpen = details.open;
  });
  return details;
}

/** `14:35` (local time of the computer). */
function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false });
}

void refresh();
// Keep the view fresh (pending uploads, today's totals, auto-close notices).
setInterval(() => {
  if (!busy) void refresh();
}, 2_000);
