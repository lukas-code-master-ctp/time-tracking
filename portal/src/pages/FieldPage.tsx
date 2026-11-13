import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  DAILY_REPORT_AUDIO_SAMPLE_RATE,
  DAILY_REPORT_MAX_AUDIO_SECONDS,
  DAILY_REPORT_MAX_CHARS,
  dailyReportDocId,
  readDailyReportSettings,
  recordingToWav,
  requiresDailyReport,
  toBase64,
  validateDailyReport,
  type DailyReport,
} from '@timetracking/shared';
import { BackendProvider, useData, useSession } from '../data/context';
import type { Backend } from '../data/types';
import { zonedDate } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { MicrophoneError, mmss, startRecording, type Recording } from '../lib/recorder';
import { LoginPage, NoAccessPage, SplashPage } from './LoginPage';

/**
 * Phone page of the people in the field (spec 2026-11-13-minuta-terreno), at
 * `/terreno`: they have no computer, so no extension. Any active person signs
 * in; the ones in the groups asked for the daily report record an audio
 * (`draftDailyReport` turns it into a draft) or write it, review it and send
 * it. Same `dailyReports` documents as the extension.
 */
export function FieldArea({ getBackend }: { getBackend: () => Backend }) {
  const [backend] = useState(getBackend);
  useHomeScreenTags();
  return (
    <BackendProvider backend={backend} access="member">
      <FieldGate />
    </BackendProvider>
  );
}

/** Manifest, icon and title so "Agregar a inicio" gives an app named "Minuta". */
function useHomeScreenTags(): void {
  useEffect(() => {
    const added: HTMLElement[] = [];
    const add = (tag: string, attrs: Record<string, string>): void => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      document.head.appendChild(el);
      added.push(el);
    };
    add('link', { rel: 'manifest', href: '/terreno.webmanifest' });
    add('link', { rel: 'apple-touch-icon', href: '/terreno/icon-180.png' });
    add('meta', { name: 'apple-mobile-web-app-title', content: 'Minuta' });
    add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
    add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
    add('meta', { name: 'theme-color', content: '#26336b' });
    const title = document.title;
    document.title = 'Minuta · Mi Pega HR';
    return () => {
      for (const el of added) el.remove();
      document.title = title;
    };
  }, []);
}

function FieldGate() {
  const { state } = useSession();
  switch (state.status) {
    case 'loading':
      return <SplashPage label="Cargando…" />;
    case 'joining':
      return <SplashPage label="Verificando tu acceso…" />;
    case 'signedOut':
      return <LoginPage variant="field" />;
    case 'noAccess':
      return <NoAccessPage variant="field" />;
    case 'ready':
      return <FieldReport uid={state.user.uid} name={state.profile.displayName || state.profile.email} />;
  }
}

/** "viernes 13 de noviembre" */
function todayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = Date.UTC(y, m - 1, d);
  const weekday = new Intl.DateTimeFormat('es-CL', { timeZone: 'UTC', weekday: 'long' }).format(at);
  const month = new Intl.DateTimeFormat('es-CL', { timeZone: 'UTC', month: 'long' }).format(at);
  return `${weekday} ${d} de ${month}`;
}

/** Message of an error of `draftDailyReport` (the function's own, in Spanish, when it gave one). */
export function draftErrorMessage(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  const message = err instanceof Error ? err.message : '';
  if (code === 'functions/deadline-exceeded') return 'La transcripción tardó demasiado. Intenta con un audio más corto o escribe la minuta.';
  if (code.startsWith('functions/') && code !== 'functions/internal' && message && message !== 'internal') return message;
  if (code === 'functions/internal') return 'No se pudo transcribir el audio. Intenta de nuevo o escribe la minuta.';
  return errorMessage(err);
}

type Phase = 'idle' | 'recording' | 'transcribing';
type Notice = { kind: 'ok' | 'warn' | 'error'; text: string } | null;

interface Loaded {
  required: boolean;
  report: DailyReport | null;
}

export function FieldReport({ uid, name }: { uid: string; name: string }) {
  const data = useData();
  const { signOut } = useSession();
  const [date] = useState(() => zonedDate(Date.now()));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [text, setText] = useState('');
  const [transcript, setTranscript] = useState<string | null>(null);
  const [sent, setSent] = useState<DailyReport | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [sending, setSending] = useState(false);
  const recording = useRef<Recording | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    void (async () => {
      try {
        const [config, groups, report] = await Promise.all([
          data.getOrgConfig(),
          data.listMyGroupIds(uid),
          data.getDailyReport(dailyReportDocId(uid, date)),
        ]);
        if (!live) return;
        const required = requiresDailyReport(readDailyReportSettings(config), groups);
        setLoaded({ required, report });
        if (report) {
          setSent(report);
          setText(report.text);
          setTranscript(report.source === 'audio' ? report.transcript : null);
        }
      } catch (err) {
        if (live) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [data, uid, date, attempt]);

  // Timer of the recording; stops by itself at the limit.
  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    setSeconds(0);
    const id = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setSeconds(s);
      if (s >= DAILY_REPORT_MAX_AUDIO_SECONDS) void stopAndTranscribe();
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => () => recording.current?.cancel(), []);

  const record = async (): Promise<void> => {
    setNotice(null);
    try {
      recording.current = await startRecording(setLevel);
      setPhase('recording');
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof MicrophoneError ? err.message : errorMessage(err) });
    }
  };

  async function stopAndTranscribe(): Promise<void> {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    setPhase('transcribing');
    setNotice({ kind: 'warn', text: 'Transcribiendo tu audio y armando la minuta. Puede tardar hasta un minuto…' });
    try {
      const blob = await rec.stop();
      let wav: Uint8Array;
      try {
        wav = await recordingToWav(blob, DAILY_REPORT_AUDIO_SAMPLE_RATE);
      } catch {
        setNotice({ kind: 'error', text: 'No se pudo leer la grabación. Intenta grabar de nuevo.' });
        return;
      }
      const draft = await data.draftDailyReport(toBase64(wav), 'audio/wav');
      if (!draft.text) {
        setNotice({ kind: 'warn', text: 'No se entendió el audio. Graba de nuevo más cerca del celular o escribe la minuta.' });
        return;
      }
      // Recording again replaces the draft; a text written by hand before is kept below it.
      const before = text.trim();
      setText(before && !transcript ? `${draft.text}\n\n${before}` : draft.text);
      setTranscript(draft.transcript || null);
      setNotice({ kind: 'ok', text: 'Listo. Revisa la minuta, corrige lo que haga falta y envíala.' });
    } catch (err) {
      setNotice({ kind: 'error', text: draftErrorMessage(err) });
    } finally {
      setPhase('idle');
      setLevel(0);
    }
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (text.trim() === '') {
      setNotice({ kind: 'error', text: 'Graba un audio o escribe tu minuta antes de enviarla.' });
      textRef.current?.focus();
      return;
    }
    const at = Date.now();
    const source = transcript ? 'audio' : 'text';
    const report: DailyReport = {
      uid,
      date,
      text: text.trim(),
      source,
      transcript: source === 'audio' ? transcript!.trim() || null : null,
      createdAt: sent?.createdAt ?? at,
      updatedAt: Math.max(at, sent?.createdAt ?? at),
    };
    if (validateDailyReport(report).length > 0) {
      setNotice({ kind: 'error', text: 'La minuta es demasiado larga.' });
      return;
    }
    setSending(true);
    try {
      await data.putDailyReport(dailyReportDocId(uid, date), report);
      setNotice({ kind: 'ok', text: sent ? 'Cambios guardados.' : '¡Gracias! Tu minuta se envió.' });
      setSent(report);
    } catch (err) {
      setNotice({ kind: 'error', text: errorMessage(err) });
    } finally {
      setSending(false);
    }
  };

  const first = name.split(/[\s@]/)[0] || name;

  return (
    <main className="field-page">
      <header className="field-top">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Mi Pega HR
        </span>
        <button type="button" className="btn small-btn" onClick={() => void signOut()}>
          Cerrar sesión
        </button>
      </header>

      <section className="field-hero">
        <p className="muted field-date">{todayLabel(date)}</p>
        <h1>Hola, {first}</h1>
      </section>

      {loadError ? (
        <section className="card field-card">
          <p className="banner error" role="alert">
            {loadError}
          </p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Reintentar
          </button>
        </section>
      ) : loaded === null ? (
        <section className="card field-card">
          <div className="state" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>Cargando…</span>
          </div>
        </section>
      ) : !loaded.required && !sent ? (
        <section className="card field-card">
          <h2>No tienes minuta pendiente</h2>
          <p className="muted">
            Tu empresa no te pidió la minuta diaria. Si crees que es un error, avísale a tu jefatura para que te agregue al
            grupo que corresponde.
          </p>
        </section>
      ) : (
        <form className="card field-card" onSubmit={(e) => void submit(e)} noValidate>
          <h2>{sent ? 'Tu minuta de hoy' : 'Cuéntanos cómo estuvo tu día'}</h2>
          {sent ? null : (
            <p className="muted">
              Graba un audio de hasta {DAILY_REPORT_MAX_AUDIO_SECONDS / 60} minutos con lo que hiciste: dónde estuviste,
              qué resolviste y qué quedó pendiente. La minuta se arma sola y tú la revisas antes de enviarla.
            </p>
          )}

          <div className="field-record">
            <button
              type="button"
              className={`field-mic${phase === 'recording' ? ' recording' : ''}`}
              onClick={() => void (phase === 'recording' ? stopAndTranscribe() : record())}
              disabled={phase === 'transcribing' || sending}
              aria-pressed={phase === 'recording'}
              style={phase === 'recording' ? { boxShadow: `0 0 0 ${Math.round(4 + level * 18)}px var(--mic-halo)` } : undefined}
            >
              {phase === 'transcribing' ? (
                <span className="spinner" aria-hidden="true" />
              ) : phase === 'recording' ? (
                <StopIcon />
              ) : (
                <MicIcon />
              )}
            </button>
            <p className="field-mic-label" aria-live="polite">
              {phase === 'recording'
                ? `Grabando ${mmss(seconds)} / ${mmss(DAILY_REPORT_MAX_AUDIO_SECONDS)} · toca para terminar`
                : phase === 'transcribing'
                  ? 'Transcribiendo…'
                  : text
                    ? 'Grabar otro audio'
                    : 'Toca para grabar'}
            </p>
          </div>

          {notice ? (
            <p className={`banner ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
              {notice.text}
            </p>
          ) : sent ? (
            <p className="banner ok" role="status">
              Ya enviaste la minuta de hoy. Puedes corregirla y guardar los cambios.
            </p>
          ) : null}

          <div className="field">
            <div className="field-head">
              <label htmlFor="field-text">Minuta</label>
              <span className="muted small">
                {text.length} / {DAILY_REPORT_MAX_CHARS}
              </span>
            </div>
            <textarea
              id="field-text"
              ref={textRef}
              rows={8}
              maxLength={DAILY_REPORT_MAX_CHARS}
              placeholder="O escríbela aquí: lugares o clientes visitados, trabajo realizado, pendientes…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={phase !== 'idle'}
            />
          </div>
          {transcript ? (
            <details className="report-transcript">
              <summary className="small">Ver transcripción del audio</summary>
              <p className="muted small">{transcript}</p>
            </details>
          ) : null}

          <button type="submit" className="btn primary field-send" disabled={phase !== 'idle' || sending}>
            {sending ? 'Enviando…' : sent ? 'Guardar cambios' : 'Enviar minuta'}
          </button>
        </form>
      )}

      <InstallHint />
    </main>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  );
}

// ---------- "Agregar a la pantalla de inicio" ----------

const HINT_KEY = 'mipega-field-install-hint';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Tip to keep the page on the home screen, like an app (hidden once installed or dismissed). */
function InstallHint() {
  const [hidden, setHidden] = useState(() => {
    try {
      return isStandalone() || localStorage.getItem(HINT_KEY) === 'hidden';
    } catch {
      return isStandalone();
    }
  });
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event): void => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  if (hidden) return null;
  const hide = (): void => {
    setHidden(true);
    try {
      localStorage.setItem(HINT_KEY, 'hidden');
    } catch {
      // private mode: hidden until the page is closed
    }
  };
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <aside className="field-install">
      <p className="strong">Déjala en tu pantalla de inicio</p>
      <p className="muted small">
        {prompt
          ? 'Así la abres como una app, sin buscar el enlace.'
          : ios
            ? 'En Safari toca Compartir y luego "Agregar a inicio". Así la abres como una app.'
            : 'En Chrome toca el menú ⋮ y luego "Agregar a la pantalla principal". Así la abres como una app.'}
      </p>
      <div className="row-actions">
        {prompt ? (
          <button
            type="button"
            className="btn primary small-btn"
            onClick={() => {
              void prompt.prompt().finally(hide);
            }}
          >
            Agregar
          </button>
        ) : null}
        <button type="button" className="btn small-btn" onClick={hide}>
          Entendido
        </button>
      </div>
    </aside>
  );
}
