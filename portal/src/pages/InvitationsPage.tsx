import { useId, useState, type FormEvent } from 'react';
import { allowedDomainsOr, formatDomains, type Invitation, type UserProfile, type WithId } from '@timetracking/shared';
import { ConfirmDialog } from '../components/Modal';
import { Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { ALLOWED_DOMAINS, EXTENSION_INSTALL_URL, isPlaceholderInstallUrl } from '../env';
import { formatRelativeDateTime } from '../lib/dates';
import { copyText } from '../lib/download';
import { errorMessage } from '../lib/messages';
import {
  INVITATION_STATUS_LABEL,
  buildInvitation,
  buildResend,
  buildRevoke,
  checkInvite,
  sortInvitations,
} from '../lib/payloads';
import { useLoad } from '../lib/useLoad';

interface InviteFormProps {
  /** Allowed Workspace domains: an email of any of them can be invited. */
  allowedDomains: readonly string[];
  invitations: readonly WithId<Invitation>[];
  users: readonly WithId<UserProfile>[];
  /** Writes the invitation; throws on failure. */
  onInvite(id: string, email: string): Promise<void>;
}

export function InviteForm({ allowedDomains, invitations, users, onInvite }: InviteFormProps) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setDone(null);
    const check = checkInvite(email, allowedDomains, invitations, users);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onInvite(check.id, check.email);
      setDone(`Invitación creada para ${check.email}. Comparte el enlace de instalación con la persona.`);
      setEmail('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="invite-form" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor={`${id}-email`}>Correo de la persona</label>
      <div className="input-row">
        <input
          id={`${id}-email`}
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder={`nombre@${allowedDomains[0] ?? 'empresa.cl'}`}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        />
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Enviando…' : 'Invitar'}
        </button>
      </div>
      <p id={`${id}-help`} className="muted small">
        Solo cuentas {formatDomains(allowedDomains)}. Comparte con la persona el enlace de instalación de la extensión (si el envío de correos está activado, además le llega por correo).
      </p>
      {error ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="banner ok" role="status">
          {done}
        </p>
      ) : null}
    </form>
  );
}

type Pending = { kind: 'resend' | 'revoke'; invitation: WithId<Invitation> };

/** Shown while the install link (`VITE_EXTENSION_INSTALL_URL`) is not a real one. */
export function InstallUrlWarning({ url }: { url: string }) {
  if (!isPlaceholderInstallUrl(url)) return null;
  return (
    <p className="banner warn" role="note" data-testid="install-url-warning">
      <strong>Falta configurar el enlace de instalación de la extensión.</strong>{' '}
      {url ? `El valor actual (${url}) es de ejemplo` : 'No hay un enlace configurado'}: define{' '}
      <code>VITE_EXTENSION_INSTALL_URL</code> en <code>portal/.env.production</code> (y <code>EXTENSION_INSTALL_URL</code> en{' '}
      <code>functions/.env.&lt;proyecto&gt;</code>) con el enlace de Chrome Web Store y vuelve a desplegar. Mientras tanto, los
      correos y el enlace copiado no llevan a la extensión real.
    </p>
  );
}

export function InvitationsPage() {
  const data = useData();
  const { uid } = useAdmin();
  const load = useLoad(async () => {
    const [invitations, users, config] = await Promise.all([data.listInvitations(), data.listUsers(), data.getOrgConfig()]);
    return { invitations, users, allowedDomains: allowedDomainsOr(config, ALLOWED_DOMAINS) };
  }, [data]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const copyLink = async (): Promise<void> => {
    const ok = await copyText(EXTENSION_INSTALL_URL);
    setNotice(ok ? 'Enlace de instalación copiado.' : `No se pudo copiar. Enlace: ${EXTENSION_INSTALL_URL}`);
  };

  const confirm = async (): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    try {
      const inv = pending.invitation;
      const next = pending.kind === 'resend' ? buildResend(inv, uid, Date.now()) : buildRevoke(inv);
      await data.putInvitation(inv.id, next);
      setNotice(pending.kind === 'resend' ? `Invitación de ${inv.email} renovada.` : `Invitación de ${inv.email} revocada.`);
      setPending(null);
      load.reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Invitaciones"
        subtitle="Invita a tu equipo. Al iniciar sesión en la extensión por primera vez, quedan como colaboradores."
        actions={
          EXTENSION_INSTALL_URL ? (
            <button type="button" className="btn" onClick={() => void copyLink()}>
              Copiar enlace de instalación
            </button>
          ) : null
        }
      />
      <InstallUrlWarning url={EXTENSION_INSTALL_URL} />
      {notice ? (
        <p className="banner ok" role="status">
          {notice}
        </p>
      ) : null}

      {load.error && !load.data ? (
        <section className="card">
          <ErrorState error={load.error} onRetry={load.reload} />
        </section>
      ) : !load.data ? (
        <section className="card">
          <Loading />
        </section>
      ) : (
        <>
          <section className="card" aria-labelledby="h-invite">
            <h2 id="h-invite">Nueva invitación</h2>
            <InviteForm
              allowedDomains={load.data.allowedDomains}
              invitations={load.data.invitations}
              users={load.data.users}
              onInvite={async (id, email) => {
                await data.putInvitation(id, buildInvitation(email, uid, Date.now()));
                load.reload();
              }}
            />
          </section>

          <section className="card flush" aria-labelledby="h-list">
            <h2 id="h-list" className="card-title">
              Invitaciones enviadas
            </h2>
            {load.data.invitations.length === 0 ? (
              <Empty title="Aún no has invitado a nadie" />
            ) : (
              <ul className="list">
                {sortInvitations(load.data.invitations).map((inv) => (
                  <li key={inv.id} className="list-item">
                    <div className="list-main">
                      <span className="strong break">{inv.email}</span>
                      <span className="muted small">
                        {inv.status === 'accepted' && inv.acceptedAt
                          ? `Aceptada ${formatRelativeDateTime(inv.acceptedAt, Date.now())}`
                          : `Invitada ${formatRelativeDateTime(inv.invitedAt, Date.now())}`}
                      </span>
                    </div>
                    <span className={`chip ${inv.status === 'pending' ? 'warn' : inv.status === 'accepted' ? 'ok' : 'muted-chip'}`}>
                      {INVITATION_STATUS_LABEL[inv.status]}
                    </span>
                    <div className="list-actions">
                      {inv.status !== 'accepted' ? (
                        <button type="button" className="btn small-btn" onClick={() => setPending({ kind: 'resend', invitation: inv })}>
                          {inv.status === 'revoked' ? 'Invitar de nuevo' : 'Reenviar'}
                        </button>
                      ) : null}
                      {inv.status === 'pending' ? (
                        <button type="button" className="btn small-btn danger-outline" onClick={() => setPending({ kind: 'revoke', invitation: inv })}>
                          Revocar
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {pending ? (
        <ConfirmDialog
          title={pending.kind === 'resend' ? 'Reenviar invitación' : 'Revocar invitación'}
          message={
            pending.kind === 'resend' ? (
              <p>
                Se renovará la invitación de <strong>{pending.invitation.email}</strong> (si el envío de correos está activado, se le enviará de nuevo el correo).
              </p>
            ) : (
              <p>
                <strong>{pending.invitation.email}</strong> ya no podrá unirse con esta invitación. Puedes invitarla de nuevo más
                adelante.
              </p>
            )
          }
          confirmLabel={pending.kind === 'resend' ? 'Reenviar' : 'Revocar'}
          danger={pending.kind === 'revoke'}
          busy={busy}
          error={actionError}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setPending(null);
            setActionError(null);
          }}
        />
      ) : null}
    </>
  );
}
