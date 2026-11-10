import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_TIME_ZONE, formatDuration, formatRutInput, normalizeRut } from '@timetracking/shared';
import { formatTime } from '../lib/dates';
import { PunchError, type Punch, type PunchAction, type PunchResult } from '../lib/kioskClient';
import { forceLightTheme } from '../lib/theme';

/** localStorage key of the device's kiosk token (set by the link from the portal). */
export const KIOSK_TOKEN_KEY = 'mipega-kiosk-token';
/** How long the result stays on screen before the next person. */
export const RESULT_MS = 6_000;

const DATE_FMT = new Intl.DateTimeFormat('es-CL', { timeZone: DEFAULT_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' });

function readToken(): string | null {
  try {
    return localStorage.getItem(KIOSK_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * The link from the portal carries the token in the `#`: it is saved on the
 * device and removed from the address bar (so it is not left on screen).
 */
export function takeTokenFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash.length >= 20) {
    try {
      localStorage.setItem(KIOSK_TOKEN_KEY, hash);
    } catch {
      // Private mode: works until the page is closed.
    }
    window.history.replaceState(null, '', window.location.pathname);
    return hash;
  }
  return readToken();
}

type Outcome = { ok: true; result: PunchResult } | { ok: false; message: string };

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'K', '0'] as const;

/**
 * Attendance kiosk (spec 2026-11-10-marcaciones), at /marcar: a tablet at the
 * office entrance where each person types her RUT and taps "Entrada" or
 * "Salida". No sign-in: the device is authorized by the token of the link
 * created in the portal (Colaboradores › Marcaciones). Always light.
 */
export function KioskPage({ getPunch }: { getPunch: () => Punch }) {
  useLayoutEffect(() => forceLightTheme(), []);
  const [token] = useState(takeTokenFromHash);
  const [punch] = useState(getPunch);
  const [now, setNow] = useState(() => Date.now());
  const [digits, setDigits] = useState('');
  const [busy, setBusy] = useState<PunchAction | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    setOutcome(null);
    setDigits('');
  }, []);

  const press = useCallback(
    (key: string) => {
      if (outcome) reset();
      setDigits((d) => {
        if (key === 'back') return d.slice(0, -1);
        if (d.length >= 9) return d;
        // K only as the last character (check digit).
        if (d.endsWith('K')) return d;
        return d + key;
      });
    },
    [outcome, reset],
  );

  const rut = normalizeRut(digits);

  const mark = useCallback(
    async (action: PunchAction) => {
      if (!token || busy) return;
      if (!rut) {
        setOutcome({ ok: false, message: digits ? 'El RUT no es válido. Revisa el dígito verificador.' : 'Escribe tu RUT.' });
        return;
      }
      setBusy(action);
      try {
        const result = await punch({ token, rut, action });
        setOutcome({ ok: true, result });
      } catch (err) {
        setOutcome({ ok: false, message: err instanceof PunchError ? err.message : 'No se pudo marcar. Intenta de nuevo.' });
      } finally {
        setBusy(null);
        clearTimeout(timer.current);
        timer.current = setTimeout(reset, RESULT_MS);
      }
    },
    [token, busy, rut, digits, punch, reset],
  );

  // Physical keyboard: digits, K, Backspace, Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'k' || e.key === 'K') press('K');
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Escape') reset();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, reset]);

  const clock = formatTime(now);
  const date = DATE_FMT.format(new Date(now));

  if (!token) {
    return (
      <main className="kiosk">
        <KioskHeader clock={clock} date={date} />
        <section className="kiosk-card kiosk-setup">
          <h1>Este dispositivo aún no es un tótem</h1>
          <p>
            Para activarlo, una persona administradora debe crear un tótem en el portal (Colaboradores › Marcaciones) y abrir aquí el
            enlace que se genera.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="kiosk">
      <KioskHeader clock={clock} date={date} />
      <section className="kiosk-card" aria-labelledby="kiosk-title">
        <h1 id="kiosk-title">Marca tu asistencia</h1>
        <p className="kiosk-hint">Escribe tu RUT y elige entrada o salida.</p>
        <output className={`kiosk-rut${digits ? '' : ' empty'}`} aria-live="polite" aria-label="RUT">
          {digits ? formatRutInput(digits) : '12.345.678-9'}
        </output>
        <div className="kiosk-pad" role="group" aria-label="Teclado">
          {KEYS.map((k) => (
            <button key={k} type="button" className="kiosk-key" onClick={() => press(k)} disabled={busy !== null}>
              {k}
            </button>
          ))}
          <button type="button" className="kiosk-key kiosk-back" onClick={() => press('back')} disabled={busy !== null} aria-label="Borrar">
            ⌫
          </button>
        </div>
        <div className="kiosk-actions">
          <button type="button" className="kiosk-go in" onClick={() => void mark('in')} disabled={busy !== null || !rut}>
            {busy === 'in' ? 'Marcando…' : 'Entrada'}
          </button>
          <button type="button" className="kiosk-go out" onClick={() => void mark('out')} disabled={busy !== null || !rut}>
            {busy === 'out' ? 'Marcando…' : 'Salida'}
          </button>
        </div>
      </section>
      {outcome ? (
        <div className={`kiosk-result ${outcome.ok ? (outcome.result.action === 'in' ? 'in' : 'out') : 'error'}`} role="alert" onClick={reset}>
          {outcome.ok ? (
            <>
              <p className="kiosk-result-title">
                {outcome.result.action === 'in' ? '¡Hola' : '¡Hasta luego'}
                {outcome.result.firstName ? `, ${outcome.result.firstName}` : ''}!
              </p>
              <p className="kiosk-result-text">
                {outcome.result.action === 'in' ? 'Entrada' : 'Salida'} registrada a las {formatTime(outcome.result.at)}
              </p>
              {outcome.result.action === 'out' ? (
                <p className="kiosk-result-sub">
                  Entraste a las {formatTime(outcome.result.startedAt)} · {formatDuration((outcome.result.at - outcome.result.startedAt) / 1000)}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="kiosk-result-title">No se pudo marcar</p>
              <p className="kiosk-result-text">{outcome.message}</p>
            </>
          )}
          <p className="kiosk-result-sub">Toca para continuar</p>
        </div>
      ) : null}
    </main>
  );
}

function KioskHeader({ clock, date }: { clock: string; date: string }) {
  return (
    <header className="kiosk-head">
      <span className="brand">
        <span className="brand-mark" aria-hidden="true" />
        Mi Pega HR
      </span>
      <div className="kiosk-clock">
        <time className="kiosk-time">{clock}</time>
        <span className="kiosk-date">{date}</span>
      </div>
    </header>
  );
}
