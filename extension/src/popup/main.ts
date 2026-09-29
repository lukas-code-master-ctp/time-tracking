/**
 * Minimal popup (redesigned in Task 5): status, dev login (dev build only),
 * start/stop the work day. All logic lives in the service worker; the popup
 * only exchanges typed messages with it.
 */
import type { PopupRequest, PopupResponse, StatusView } from '../messages';

const root = document.getElementById('app') as HTMLElement;
let busy = false;
let lastError: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastRendered = '';

async function send(req: PopupRequest): Promise<PopupResponse> {
  try {
    const res = (await chrome.runtime.sendMessage(req)) as PopupResponse | undefined;
    return res ?? { ok: false, error: 'Sin respuesta de la extensión.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function act(req: PopupRequest): Promise<void> {
  if (busy) return;
  busy = true;
  render(null);
  const res = await send(req);
  busy = false;
  lastError = res.ok ? null : res.error;
  lastRendered = JSON.stringify([res.status ?? null, lastError]);
  render(res.status ?? null);
  if (!res.status) void refresh();
}

/** Re-renders only when something changed (keeps a half-typed email intact). */
async function refresh(): Promise<void> {
  const res = await send({ type: 'status' });
  if (!res.ok) lastError = res.error;
  const key = JSON.stringify([res.status ?? null, lastError]);
  if (key === lastRendered) return;
  lastRendered = key;
  render(res.status ?? null);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let current: StatusView | null = null;

function render(status: StatusView | null): void {
  if (status) current = status;
  const s = current;
  root.replaceChildren();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!s) {
    root.append(busy ? 'Procesando…' : 'Cargando…');
    return;
  }
  if (s.notice) root.append(el('div', { className: 'notice', textContent: s.notice }));
  if (lastError) root.append(el('div', { className: 'error', role: 'alert', textContent: lastError }));

  if (!s.user) {
    if (s.appEnv === 'dev') {
      const input = el('input', { type: 'email', placeholder: 'correo@compratuparcela.cl', required: true, id: 'email' });
      const form = el('form', {}, [
        el('label', { htmlFor: 'email', textContent: 'Correo (login de desarrollo)' }),
        input,
        el('button', { type: 'submit', className: 'primary', textContent: 'Entrar (emulador)', disabled: busy }),
      ]);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void act({ type: 'auth.devSignIn', email: input.value });
      });
      root.append(form);
    } else {
      const btn = el('button', { className: 'primary', textContent: 'Iniciar sesión con Google', disabled: busy });
      btn.addEventListener('click', () => void act({ type: 'auth.signIn' }));
      root.append(btn);
    }
    return;
  }

  root.append(el('div', { className: 'muted', textContent: s.user.email ?? s.user.uid }));

  if (!s.profile) {
    root.append(
      el('p', {
        textContent: s.joinError ? s.joinError.message : 'Validando tu cuenta…',
      }),
    );
    const retry = el('button', { textContent: 'Reintentar', disabled: busy });
    retry.addEventListener('click', () => void act({ type: 'auth.refreshProfile' }));
    root.append(retry);
  } else if (s.session) {
    const clock = el('p', { textContent: `Jornada en curso: ${duration(Date.now() - s.session.startedAt)}` });
    const startedAt = s.session.startedAt;
    timer = setInterval(() => {
      clock.textContent = `Jornada en curso: ${duration(Date.now() - startedAt)}`;
    }, 1000);
    const stop = el('button', { className: 'danger', textContent: 'Cerrar jornada', disabled: busy });
    stop.addEventListener('click', () => void act({ type: 'session.stop' }));
    root.append(clock, stop);
  } else {
    const start = el('button', { className: 'primary', textContent: 'Iniciar jornada', disabled: busy });
    start.addEventListener('click', () => void act({ type: 'session.start' }));
    root.append(start);
  }

  root.append(
    el('p', {
      className: 'muted',
      textContent:
        s.pendingOps > 0 ? `${s.pendingOps} envío(s) pendiente(s)` : s.lastSyncOkAt ? 'Todo enviado' : '',
    }),
  );
  if (!s.session) {
    const out = el('button', { textContent: 'Cerrar sesión', disabled: busy });
    out.addEventListener('click', () => void act({ type: 'auth.signOut' }));
    root.append(out);
  }
}

void refresh();
// Keep the view fresh (pending uploads, auto-close notices).
setInterval(() => {
  if (!busy) void refresh();
}, 2_000);
