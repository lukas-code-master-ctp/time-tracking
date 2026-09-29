import { useState } from 'react';
import { Link } from 'react-router';
import { type Role, type UserProfile, type UserStatus, type WithId } from '@timetracking/shared';
import { ConfirmDialog } from '../components/Modal';
import { initials } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { formatRelativeDateTime } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { useLoad } from '../lib/useLoad';

type Change = { user: WithId<UserProfile>; role: Role; status: UserStatus };

const ROLE_LABEL: Record<Role, string> = { admin: 'Administrador', member: 'Colaborador' };

function describeChange(c: Change): { title: string; message: string; confirm: string; danger: boolean } {
  const name = c.user.displayName || c.user.email;
  if (c.status !== c.user.status) {
    return c.status === 'disabled'
      ? {
          title: 'Desactivar cuenta',
          message: `${name} ya no podrá iniciar jornada ni entrar al portal. Sus horas registradas se conservan.`,
          confirm: 'Desactivar',
          danger: true,
        }
      : { title: 'Activar cuenta', message: `${name} podrá volver a registrar su jornada.`, confirm: 'Activar', danger: false };
  }
  return c.role === 'admin'
    ? {
        title: 'Hacer administrador',
        message: `${name} podrá ver los datos de todo el equipo, invitar personas y cambiar la configuración.`,
        confirm: 'Hacer administrador',
        danger: false,
      }
    : { title: 'Quitar permisos de administrador', message: `${name} pasará a ser colaborador.`, confirm: 'Quitar permisos', danger: true };
}

export function UsersPage() {
  const data = useData();
  const { uid: me } = useAdmin();
  const load = useLoad(() => data.listUsers(), [data]);
  const [change, setChange] = useState<Change | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = async (): Promise<void> => {
    if (!change) return;
    setBusy(true);
    setError(null);
    try {
      await data.updateUser(change.user.id, { role: change.role, status: change.status });
      setNotice(`Cambios guardados para ${change.user.displayName || change.user.email}.`);
      setChange(null);
      load.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const users = [...(load.data ?? [])].sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) ||
      (a.displayName || a.email).localeCompare(b.displayName || b.email, 'es'),
  );
  const info = change ? describeChange(change) : null;

  return (
    <>
      <PageHeader title="Colaboradores" subtitle="Personas registradas. Cambia su rol o desactiva su cuenta." />
      {notice ? (
        <p className="banner ok" role="status">
          {notice}
        </p>
      ) : null}
      <section className="card flush" aria-label="Colaboradores registrados">
        {load.error && !load.data ? (
          <ErrorState error={load.error} onRetry={load.reload} />
        ) : !load.data ? (
          <Loading />
        ) : users.length === 0 ? (
          <Empty title="Aún no hay colaboradores">
            <Link to="/invitaciones">Invita a tu equipo</Link>
          </Empty>
        ) : (
          <ul className="list">
            {users.map((u) => {
              const self = u.id === me;
              const name = u.displayName || u.email;
              return (
                <li key={u.id} className={`list-item${u.status === 'disabled' ? ' dimmed' : ''}`}>
                  <div className="person">
                    <span className="avatar" aria-hidden="true">
                      {initials(name)}
                    </span>
                    <span className="person-text">
                      <span className="person-name">
                        {name}
                        {self ? <span className="muted"> (tú)</span> : null}
                      </span>
                      <span className="person-email">{u.email}</span>
                      <span className="muted small">
                        Desde {formatRelativeDateTime(u.createdAt, Date.now())}
                        {u.consentAcceptedAt ? ' · aceptó el aviso' : ' · aún no acepta el aviso'}
                      </span>
                    </span>
                  </div>
                  <div className="list-actions">
                    <label className="sr-only" htmlFor={`role-${u.id}`}>
                      Rol de {name}
                    </label>
                    <select
                      id={`role-${u.id}`}
                      value={u.role}
                      disabled={self}
                      title={self ? 'No puedes cambiar tu propio rol' : undefined}
                      onChange={(e) => {
                        setNotice(null);
                        setChange({ user: u, role: e.target.value as Role, status: u.status });
                      }}
                    >
                      <option value="member">{ROLE_LABEL.member}</option>
                      <option value="admin">{ROLE_LABEL.admin}</option>
                    </select>
                    {u.status === 'active' ? (
                      <span className="chip ok">Activo</span>
                    ) : (
                      <span className="chip">Desactivado</span>
                    )}
                    <button
                      type="button"
                      className={`btn small-btn${u.status === 'active' ? ' danger-outline' : ''}`}
                      disabled={self}
                      title={self ? 'No puedes desactivar tu propia cuenta' : undefined}
                      onClick={() => {
                        setNotice(null);
                        setChange({ user: u, role: u.role, status: u.status === 'active' ? 'disabled' : 'active' });
                      }}
                    >
                      {u.status === 'active' ? 'Desactivar' : 'Activar'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="muted small footnote">No puedes cambiar tu propio rol ni desactivarte: pídeselo a otro administrador.</p>

      {change && info ? (
        <ConfirmDialog
          title={info.title}
          message={<p>{info.message}</p>}
          confirmLabel={info.confirm}
          danger={info.danger}
          busy={busy}
          error={error}
          onConfirm={() => void apply()}
          onCancel={() => {
            setChange(null);
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}
