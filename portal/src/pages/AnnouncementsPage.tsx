import { useId, useState, type FormEvent } from 'react';
import {
  MAX_ANNOUNCEMENT_BODY,
  MAX_ANNOUNCEMENT_TITLE,
  readSummary,
  validateAnnouncement,
  type Announcement,
  type AnnouncementRead,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { ConfirmDialog } from '../components/Modal';
import { initials } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { formatRelativeDateTime } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { useLoad } from '../lib/useLoad';

/** Default sender of a new announcement (editable). */
export const DEFAULT_AUTHOR = 'Recursos Humanos';

interface Draft {
  authorName: string;
  title: string;
  body: string;
}

const nameOf = (u: UserProfile): string => u.displayName || u.email;

/**
 * "Comunicados" (spec 2026-11-05-comunicados): an admin publishes internal
 * announcements; the extension notifies every active person, who confirms
 * the reading. Here: the form, and each announcement with who read it and
 * who not yet, archive (stops showing it in the extension) and delete.
 */
export function AnnouncementsPage() {
  const data = useData();
  const { uid: me } = useAdmin();
  const id = useId();
  const load = useLoad(async () => {
    const [announcements, reads, users] = await Promise.all([data.listAnnouncements(), data.listAnnouncementReads(), data.listUsers()]);
    return { announcements, reads, people: users.filter((u) => u.status === 'active').sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'es')) };
  }, [data]);

  const [draft, setDraft] = useState<Draft>({ authorName: DEFAULT_AUTHOR, title: '', body: '' });
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WithId<Announcement> | null>(null);

  const issues = validateAnnouncement(draft);
  const issue = (path: string): string | undefined => (touched ? issues.find((i) => i.path === path)?.message : undefined);
  const people = load.data?.people ?? [];

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setTouched(true);
    setNotice(null);
    if (issues.length === 0) setConfirming(true);
  };

  const publish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const newId = await data.createAnnouncement({
        title: draft.title.trim(),
        body: draft.body.trim(),
        authorName: draft.authorName.trim(),
        createdAt: Date.now(),
        createdBy: me,
        archivedAt: null,
      });
      setConfirming(false);
      setDraft({ authorName: draft.authorName, title: '', body: '' });
      setTouched(false);
      setNotice('Comunicado publicado. Llega a la extensión en unos minutos.');
      setOpen(newId);
      load.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await data.deleteAnnouncement(deleting.id);
      setDeleting(null);
      setNotice('Comunicado eliminado.');
      load.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Comunicados"
        subtitle="Publica avisos para el equipo. Llegan como notificación a la extensión y cada persona confirma que los leyó."
      />
      {notice ? (
        <p className="banner ok" role="status">
          {notice}
        </p>
      ) : null}

      <section className="card" aria-labelledby={`${id}-new`}>
        <h2 id={`${id}-new`}>Nuevo comunicado</h2>
        <form className="announcement-form" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={`${id}-author`}>Remitente</label>
            <input
              id={`${id}-author`}
              type="text"
              value={draft.authorName}
              maxLength={80}
              aria-invalid={issue('authorName') ? true : undefined}
              onChange={(e) => setDraft({ ...draft, authorName: e.target.value })}
            />
            {issue('authorName') ? <span className="field-error">{issue('authorName')}</span> : null}
          </div>
          <div className="field">
            <label htmlFor={`${id}-title`}>Título</label>
            <input
              id={`${id}-title`}
              type="text"
              value={draft.title}
              maxLength={MAX_ANNOUNCEMENT_TITLE}
              placeholder="Ej.: Nuevo reglamento interno"
              aria-invalid={issue('title') ? true : undefined}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            {issue('title') ? <span className="field-error">{issue('title')}</span> : null}
          </div>
          <div className="field">
            <label htmlFor={`${id}-body`}>Mensaje</label>
            <textarea
              id={`${id}-body`}
              value={draft.body}
              rows={6}
              maxLength={MAX_ANNOUNCEMENT_BODY}
              aria-invalid={issue('body') ? true : undefined}
              aria-describedby={`${id}-count`}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <span id={`${id}-count`} className="muted small">
              {draft.body.length} / {MAX_ANNOUNCEMENT_BODY}
            </span>
            {issue('body') ? <span className="field-error">{issue('body')}</span> : null}
          </div>
          <div className="form-actions">
            <button type="submit" className="btn primary">
              Publicar
            </button>
          </div>
        </form>
      </section>

      <section className="card flush" aria-labelledby={`${id}-list`}>
        <h2 id={`${id}-list`} className="card-title">
          Publicados
        </h2>
        {load.error && !load.data ? (
          <ErrorState error={load.error} onRetry={load.reload} />
        ) : !load.data ? (
          <Loading />
        ) : load.data.announcements.length === 0 ? (
          <Empty title="Aún no hay comunicados">Escribe el primero en el formulario de arriba.</Empty>
        ) : (
          <ul className="list">
            {load.data.announcements.map((a) => (
              <AnnouncementItem
                key={a.id}
                announcement={a}
                people={people}
                reads={load.data!.reads}
                open={open === a.id}
                onToggle={() => setOpen(open === a.id ? null : a.id)}
                onArchive={async (archivedAt) => {
                  setNotice(null);
                  await data.setAnnouncementArchived(a.id, archivedAt);
                  load.reload();
                }}
                onDelete={() => {
                  setNotice(null);
                  setError(null);
                  setDeleting(a);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {confirming ? (
        <ConfirmDialog
          title="Publicar comunicado"
          message={
            <p>
              «{draft.title.trim()}» llegará como notificación a {people.length === 1 ? '1 persona activa' : `${people.length} personas activas`}.
              Una vez publicado no se puede editar: solo archivar o eliminar.
            </p>
          }
          confirmLabel="Publicar"
          busy={busy}
          error={error}
          onConfirm={() => void publish()}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Eliminar comunicado"
          message={<p>«{deleting.title}» y sus confirmaciones de lectura dejarán de verse. Si solo quieres que deje de aparecer en la extensión, archívalo.</p>}
          confirmLabel="Eliminar"
          danger
          busy={busy}
          error={error}
          onConfirm={() => void remove()}
          onCancel={() => {
            setDeleting(null);
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}

interface ItemProps {
  announcement: WithId<Announcement>;
  people: readonly WithId<UserProfile>[];
  reads: readonly AnnouncementRead[];
  open: boolean;
  onToggle(): void;
  onArchive(archivedAt: number | null): Promise<void>;
  onDelete(): void;
}

function AnnouncementItem({ announcement: a, people, reads, open, onToggle, onArchive, onDelete }: ItemProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { read, unread } = readSummary(a.id, people, reads);
  const all = people.length > 0 && unread.length === 0;
  const panelId = `announcement-${a.id}`;
  const now = Date.now();

  const archive = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onArchive(a.archivedAt === null ? Date.now() : null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`list-item announcement-item${a.archivedAt !== null ? ' dimmed' : ''}`}>
      <div className="list-main">
        <span className="person-name">{a.title}</span>
        <span className="muted small">
          {a.authorName} · {formatRelativeDateTime(a.createdAt, now)}
        </span>
      </div>
      <div className="list-actions">
        {a.archivedAt !== null ? <span className="chip">Archivado</span> : null}
        <span className={`chip${all ? ' ok' : ''}`}>
          Leído por {read.length} de {people.length}
        </span>
        <button type="button" className="btn small-btn" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
          {open ? 'Cerrar' : 'Ver lecturas'}
        </button>
        <button type="button" className="btn small-btn" disabled={busy} onClick={() => void archive()}>
          {a.archivedAt === null ? 'Archivar' : 'Mostrar de nuevo'}
        </button>
        <button type="button" className="btn small-btn danger-outline" disabled={busy} onClick={onDelete} aria-label={`Eliminar «${a.title}»`}>
          Eliminar
        </button>
      </div>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
      {open ? (
        <div id={panelId} className="list-panel announcement-panel" role="region" aria-label={`Lecturas de «${a.title}»`}>
          <p className="announcement-body">{a.body}</p>
          <div className="read-columns">
            <div>
              <h3>Leyeron ({read.length})</h3>
              {read.length === 0 ? (
                <p className="muted small">Nadie todavía.</p>
              ) : (
                <ul className="read-list">
                  {read.map(({ person, readAt }) => (
                    <li key={person.id}>
                      <span className="avatar small-avatar" aria-hidden="true">
                        {initials(nameOf(person))}
                      </span>
                      <span className="read-name">{nameOf(person)}</span>
                      <span className="muted small">{formatRelativeDateTime(readAt, now)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3>Pendientes ({unread.length})</h3>
              {unread.length === 0 ? (
                <p className="muted small">{people.length === 0 ? 'No hay personas activas.' : 'Todos lo leyeron.'}</p>
              ) : (
                <ul className="read-list">
                  {unread.map((person) => (
                    <li key={person.id}>
                      <span className="avatar small-avatar" aria-hidden="true">
                        {initials(nameOf(person))}
                      </span>
                      <span className="read-name">{nameOf(person)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}
