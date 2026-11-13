import { useLayoutEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useSession } from '../data/context';
import { formatDomains, isAllowedEmail } from '@timetracking/shared';
import { ALLOWED_DOMAINS, HAS_PLACEHOLDERS } from '../env';
import { forceLightTheme } from '../lib/theme';
import { PRIVACY_PATH } from './PrivacyPage';

/** Minimum length asked for new passwords (Firebase itself asks for 6). */
export const MIN_PASSWORD = 8;

/** The sign-in screens are always light, whatever theme the admin picked for the portal. */
function useLightTheme(): void {
  useLayoutEffect(() => forceLightTheme(), []);
}

function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true" />
      Mi Pega HR
    </span>
  );
}

/** Admin portal, or the phone page of the people in the field (spec 2026-11-13-minuta-terreno). */
export type AuthVariant = 'admin' | 'field';

/** Two columns on wide screens: the sticky note with what the portal does, and the form. */
function AuthLayout({ variant = 'admin', children }: { variant?: AuthVariant; children: ReactNode }) {
  useLightTheme();
  return (
    <main className={`auth-page${variant === 'field' ? ' auth-field' : ''}`}>
      <aside className="auth-aside" aria-hidden="true">
        {variant === 'field' ? (
          <div className="auth-note">
            <p className="auth-note-kicker">Personas en terreno</p>
            <p className="auth-note-title">
              Tu minuta del día, <span className="auth-note-mark">desde el celular</span>
            </p>
            <ul>
              <li>Graba un audio contando tu día</li>
              <li>La minuta se arma sola y tú la revisas</li>
              <li>Llega directo a tu empresa</li>
            </ul>
          </div>
        ) : (
          <div className="auth-note">
            <p className="auth-note-kicker">Portal de administración</p>
            <p className="auth-note-title">
              Todo el equipo, <span className="auth-note-mark">en una hoja</span>
            </p>
            <ul>
              <li>Horas, actividad y pausas activas de cada persona</li>
              <li>Ausencias, comunicados y pulso de ánimo</li>
              <li>Invitaciones, horarios y permisos</li>
            </ul>
          </div>
        )}
      </aside>
      <div className="auth-main">
        <div className="auth-card">
          <Brand />
          {children}
        </div>
        <p className="auth-foot small">
          <Link to={PRIVACY_PATH}>Política de privacidad</Link>
          <span aria-hidden="true"> · </span>
          <a href="https://www.mipegahr.cl">mipegahr.cl</a>
        </p>
      </div>
    </main>
  );
}

/** Official multicolor "G" (Google sign-in branding guidelines). */
function GoogleLogo() {
  return (
    <svg className="google-logo" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {open ? null : <path d="M4 4l16 16" />}
    </svg>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  hint?: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={id}>{label}</label>
        {hint}
      </div>
      <div className="password-input">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          minLength={autoComplete === 'new-password' ? MIN_PASSWORD : undefined}
          required
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          aria-pressed={shown}
        >
          <EyeIcon open={!shown} />
        </button>
      </div>
    </div>
  );
}

type Mode = 'signIn' | 'signUp' | 'reset';

const TITLES: Record<Mode, { title: string; lead: string }> = {
  signIn: { title: 'Inicia sesión', lead: 'Entra al portal para revisar y administrar a tu equipo.' },
  signUp: {
    title: 'Crea tu contraseña',
    lead: 'Para entrar con tu correo de la empresa en vez de Google. Te enviaremos un enlace para confirmarlo.',
  },
  reset: {
    title: 'Recupera tu contraseña',
    lead: 'Escribe tu correo y te enviaremos un enlace para crear una contraseña nueva.',
  },
};

const FIELD_LEAD = 'Entra con tu correo de la empresa para enviar la minuta de tu día.';

export function LoginPage({ variant = 'admin' }: { variant?: AuthVariant }) {
  const { state, signIn, signInWithPassword, createPasswordAccount, sendPasswordReset, clearMessage, signInDev } =
    useSession();
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devEmail, setDevEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const error = localError || (state.status === 'signedOut' ? state.error : undefined);
  const notice = state.status === 'signedOut' ? state.notice : undefined;

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const go = (next: Mode): void => {
    setMode(next);
    setPassword('');
    setLocalError('');
    clearMessage();
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const address = email.trim();
    setLocalError('');
    clearMessage();
    if (mode !== 'reset' && !isAllowedEmail(address, ALLOWED_DOMAINS)) {
      setLocalError(`Usa tu correo de la empresa (${formatDomains(ALLOWED_DOMAINS)}).`);
      return;
    }
    if (mode === 'signIn') {
      void run(() => signInWithPassword(address, password));
    } else if (mode === 'signUp') {
      if (password.length < MIN_PASSWORD) {
        setLocalError(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
        return;
      }
      void run(async () => {
        if (await createPasswordAccount(address, password)) {
          setMode('signIn');
          setPassword('');
        }
      });
    } else {
      void run(async () => {
        if (await sendPasswordReset(address)) setMode('signIn');
      });
    }
  };

  const onDev = (e: FormEvent): void => {
    e.preventDefault();
    if (signInDev && devEmail.trim()) void run(() => signInDev(devEmail.trim()));
  };

  const { title } = TITLES[mode];
  const lead = variant === 'field' && mode === 'signIn' ? FIELD_LEAD : TITLES[mode].lead;
  const placeholder = `nombre@${ALLOWED_DOMAINS[0] ?? 'empresa.cl'}`;

  return (
    <AuthLayout variant={variant}>
      <div className="auth-head">
        <h1>{title}</h1>
        <p className="muted">{lead}</p>
      </div>

      {notice ? (
        <p className="banner ok" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : null}
      {!import.meta.env.DEV && HAS_PLACEHOLDERS ? (
        <p className="banner warn">Este build no tiene configurado el proyecto de Firebase (.env.production).</p>
      ) : null}

      {mode === 'signIn' ? (
        <>
          <button type="button" className="btn google-btn" onClick={() => void run(signIn)} disabled={busy}>
            <GoogleLogo />
            Continuar con Google
          </button>
          <p className="auth-divider">
            <span>o con tu correo</span>
          </p>
        </>
      ) : null}

      <form className="auth-form" onSubmit={onSubmit} noValidate={false}>
        <div className="field">
          <label htmlFor="login-email">Correo de la empresa</label>
          <input
            id="login-email"
            type="email"
            autoComplete={mode === 'signUp' ? 'username' : 'email'}
            inputMode="email"
            placeholder={placeholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        {mode === 'signIn' ? (
          <PasswordField
            id="login-password"
            label="Contraseña"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            hint={
              <button type="button" className="link-btn" onClick={() => go('reset')}>
                ¿Olvidaste tu contraseña?
              </button>
            }
          />
        ) : null}
        {mode === 'signUp' ? (
          <PasswordField
            id="login-new-password"
            label="Contraseña nueva"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            hint={<span className="muted small">Mínimo {MIN_PASSWORD} caracteres</span>}
          />
        ) : null}
        <button type="submit" className="btn primary big" disabled={busy}>
          {busy ? <span className="spinner small" aria-hidden="true" /> : null}
          {mode === 'signIn' ? 'Iniciar sesión' : mode === 'signUp' ? 'Crear contraseña' : 'Enviar enlace'}
        </button>
      </form>

      <p className="auth-switch small">
        {mode === 'signIn' ? (
          <>
            ¿Nunca has entrado con correo?{' '}
            <button type="button" className="link-btn" onClick={() => go('signUp')}>
              Crea tu contraseña
            </button>
          </>
        ) : (
          <button type="button" className="link-btn" onClick={() => go('signIn')}>
            ← Volver a iniciar sesión
          </button>
        )}
      </p>

      <p className="auth-note-domains muted small">
        Solo para administradores con cuenta {formatDomains(ALLOWED_DOMAINS)}. El resto del equipo usa la extensión de
        Chrome.
      </p>

      {import.meta.env.DEV && signInDev ? (
        <form className="dev-login" onSubmit={onDev}>
          <p className="small strong">Modo desarrollo (emuladores)</p>
          <label htmlFor="dev-email">Correo simulado</label>
          <input
            id="dev-email"
            type="email"
            autoComplete="off"
            placeholder={`correo@${ALLOWED_DOMAINS[0] ?? 'empresa.cl'}`}
            value={devEmail}
            onChange={(e) => setDevEmail(e.target.value)}
            required
          />
          <button type="submit" className="btn" disabled={busy}>
            Entrar (emulador)
          </button>
        </form>
      ) : null}
    </AuthLayout>
  );
}

export function NoAccessPage({ variant = 'admin' }: { variant?: AuthVariant }) {
  const { state, signOut, retry } = useSession();
  const message = state.status === 'noAccess' ? state.message : '';
  const email = state.status === 'noAccess' ? state.user.email : null;
  return (
    <AuthLayout variant={variant}>
      <div className="auth-head">
        <h1>Sin acceso</h1>
        {email ? <p className="muted">Sesión iniciada como {email}.</p> : null}
      </div>
      <p className="banner warn" role="alert">
        {message}
      </p>
      <div className="row-actions">
        <button type="button" className="btn" onClick={retry}>
          Reintentar
        </button>
        <button type="button" className="btn primary" onClick={() => void signOut()}>
          Usar otra cuenta
        </button>
      </div>
    </AuthLayout>
  );
}

export function SplashPage({ label }: { label: string }) {
  useLightTheme();
  return (
    <main className="auth-page splash">
      <div className="state" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </main>
  );
}
