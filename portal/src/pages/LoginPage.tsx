import { useState, type FormEvent, type ReactNode } from 'react';
import { useSession } from '../data/context';
import { ALLOWED_DOMAIN, HAS_PLACEHOLDERS } from '../env';

function AuthCard({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card card">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Registro de jornada
        </span>
        {children}
      </div>
    </main>
  );
}

export function LoginPage() {
  const { state, signIn, signInDev } = useSession();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const error = state.status === 'signedOut' ? state.error : undefined;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const onDev = (e: FormEvent): void => {
    e.preventDefault();
    if (signInDev && email.trim()) void run(() => signInDev(email.trim()));
  };

  return (
    <AuthCard>
      <h1>Portal de administración</h1>
      <p className="muted">Revisa las horas y la actividad del equipo, invita colaboradores y ajusta la configuración.</p>
      {error ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : null}
      {!import.meta.env.DEV && HAS_PLACEHOLDERS ? (
        <p className="banner warn">Este build no tiene configurado el proyecto de Firebase (.env.production).</p>
      ) : null}
      <button type="button" className="btn primary big" onClick={() => void run(signIn)} disabled={busy}>
        Iniciar sesión con Google
      </button>
      <p className="muted small">Usa tu cuenta @{ALLOWED_DOMAIN}. Solo los administradores tienen acceso.</p>
      {import.meta.env.DEV && signInDev ? (
        <form className="dev-login" onSubmit={onDev}>
          <p className="small strong">Modo desarrollo (emuladores)</p>
          <label htmlFor="dev-email">Correo simulado</label>
          <input
            id="dev-email"
            type="email"
            autoComplete="off"
            placeholder={`correo@${ALLOWED_DOMAIN}`}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button type="submit" className="btn" disabled={busy}>
            Entrar (emulador)
          </button>
        </form>
      ) : null}
    </AuthCard>
  );
}

export function NoAccessPage() {
  const { state, signOut, retry } = useSession();
  const message = state.status === 'noAccess' ? state.message : '';
  const email = state.status === 'noAccess' ? state.user.email : null;
  return (
    <AuthCard>
      <h1>Sin acceso</h1>
      <p className="banner warn" role="alert">
        {message}
      </p>
      {email ? <p className="muted small">Sesión iniciada como {email}.</p> : null}
      <div className="row-actions">
        <button type="button" className="btn" onClick={retry}>
          Reintentar
        </button>
        <button type="button" className="btn primary" onClick={() => void signOut()}>
          Usar otra cuenta
        </button>
      </div>
    </AuthCard>
  );
}

export function SplashPage({ label }: { label: string }) {
  return (
    <main className="auth-page">
      <div className="state" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </main>
  );
}
