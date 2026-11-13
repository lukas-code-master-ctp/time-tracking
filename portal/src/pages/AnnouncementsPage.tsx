import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  MAX_ANNOUNCEMENT_BODY,
  MAX_ANNOUNCEMENT_TITLE,
  announcementPublishAt,
  isForEveryone,
  isScheduled,
  readSummary,
  sortGroups,
  validateAnnouncement,
  validateAnnouncementDelivery,
  type Announcement,
  type AnnouncementRead,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { ConfirmDialog } from '../components/Modal';
import { initials } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import {
  audienceFor,
  audienceLabel,
  defaultScheduleTime,
  fromLocalInput,
  recipientsOf,
  toLocalInput,
  upgradeLegacyAnnouncements,
} from '../lib/announcements';
import { formatRelativeDateTime } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { useLoad } from '../lib/useLoad';

/** Default sender of a new announcement (editable). */
export const DEFAULT_AUTHOR = 'Recursos Humanos';

interface Draft {
  authorName: string;
  title: string;
  body: string;
  /** Only to some groups (false = everyone). */
  toGroups: boolean;
  groupIds: string[];
  /** Scheduled (false = right away). */
  scheduled: boolean;
  /** `datetime-local` value. */
  when: string;
}

const emptyDraft = (authorName: string): Draft => ({ authorName, title: '', body: '', toGroups: false, groupIds: [], scheduled: false, when: '' });

const nameOf = (u: UserProfile): string => u.displayName || u.email;

const peopleCount = (n: number): string => (n === 1 ? '1 persona' : `${n} personas`);

/**
 * "Comunicados" (specs 2026-11-05-comunicados and
 * 2026-11-13-grupos-y-comunicados-agendados): an admin publishes internal
 * announcements, right away or at a chosen time, to everyone or to some
 * groups; the extension notifies those people, who confirm the reading.
 * Here: the form, the scheduled ones (edit, send now, delete) and the sent
 * ones with who read them, archive and delete.
 */
export function AnnouncementsPage() {
  const data = useData();
  const { uid: me } = useAdmin();
  const id = useId();
  const load = useLoad(async () => {
    const [announcements, reads, users, groups] = await Promise.all([
      data.listAnnouncements(),
      data.listAnnouncementReads(),
      data.listUsers(),
      data.listGroups(),
    ]);
    return {
      announcements: await upgradeLegacyAnnouncements(data, announcements),
      reads,
      groups: sortGroups(groups),
      people: users.filter((u) => u.status === 'active').sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'es')),
    };
  }, [data]);

  const [draft, setDraft] = useState<Draft>(emptyDraft(DEFAULT_AUTHOR));
  const [editing, setEditing] = useState<WithId<Announcement> | null>(null);
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WithId<Announcement> | null>(null);
  const [sendingNow, setSendingNow] = useState<WithId<Announcement> | null>(null);

  const now = Date.now();
  const people = load.data?.people ?? [];
  const groups = load.data?.groups ?? [];
  const groupIds = draft.toGroups ? draft.groupIds : null;
  const audience = audienceFor(groupIds, groups);
  const recipients = recipientsOf({ audience }, people);
  const publishAt = draft.scheduled ? fromLocalInput(draft.when) : null;
  const issues = [
    ...validateAnnouncement(draft),
    ...validateAnnouncementDelivery({ publishAt, groupIds, members: groupIds === null ? [] : audience }, now),
  ];
  const issue = (path: string): string | undefined => (touched ? issues.find((i) => i.path === path)?.message : undefined);
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));

  const all = load.data?.announcements ?? [];
  const scheduled = all.filter((a) => a.archivedAt === null && isScheduled(a, now)).sort((a, b) => announcementPublishAt(a) - announcementPublishAt(b));
  const sent = all.filter((a) => !scheduled.includes(a)).sort((a, b) => announcementPublishAt(b) - announcementPublishAt(a));

  const reset = (): void => {
    setDraft(emptyDraft(draft.authorName));
    setEditing(null);
    setTouched(false);
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setTouched(true);
    setNotice(null);
    if (issues.length === 0) setConfirming(true);
  };

  const startEdit = (a: WithId<Announcement>): void => {
    setNotice(null);
    setTouched(false);
    setEditing(a);
    setDraft({
      authorName: a.authorName,
      title: a.title,
      body: a.body,
      toGroups: !isForEveryone(a),
      groupIds: isForEveryone(a) ? [] : (a.groupIds ?? []).filter((g) => groups.some((x) => x.id === g)),
      scheduled: true,
      when: toLocalInput(announcementPublishAt(a)),
    });
    document.getElementById(`${id}-new`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const publish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const at = Date.now();
      const fields = {
        title: draft.title.trim(),
        body: draft.body.trim(),
        authorName: draft.authorName.trim(),
        publishAt: publishAt ?? at,
        audience,
        groupIds: groupIds ?? [],
      };
      let target: string;
      if (editing) {
        await data.updateAnnouncement(editing.id, fields);
        target = editing.id;
      } else {
        target = await data.createAnnouncement({ ...fields, createdAt: at, createdBy: me, archivedAt: null });
      }
      setConfirming(false);
      setNotice(
        editing
          ? 'Cambios guardados.'
          : publishAt === null
            ? 'Comunicado publicado. Llega a la extensión en unos minutos.'
            : `Comunicado programado para ${formatRelativeDateTime(publishAt, at)}.`,
      );
      reset();
      setOpen(publishAt === null ? target : null);
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
      if (editing?.id === deleting.id) reset();
      setDeleting(null);
      setNotice('Comunicado eliminado.');
      load.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async (): Promise<void> => {
    if (!sendingNow) return;
    setBusy(true);
    setError(null);
    try {
      // The rules want publishAt >= createdAt.
      await data.updateAnnouncement(sendingNow.id, { publishAt: Math.max(Date.now(), sendingNow.createdAt) });
      if (editing?.id === sendingNow.id) reset();
      setSendingNow(null);
      setNotice('Comunicado enviado. Llega a la extensión en unos minutos.');
      setOpen(sendingNow.id);
      load.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmWhen = publishAt === null || !Number.isFinite(publishAt) ? 'ahora' : formatRelativeDateTime(publishAt, now);
  const confirmTo = groupIds === null ? 'todo el equipo' : `grupos: ${audienceLabel({ audience, groupIds }, groups)}`;

  return (
    <>
      <PageHeader
        title="Comunicados"
        subtitle="Publica avisos para todo el equipo o para algunos grupos, ahora o programados. Llegan como notificación a la extensión y cada persona confirma que los leyó."
      />
      {notice ? (
        <p className="banner ok" role="status">
          {notice}
        </p>
      ) : null}

      <section className="card" aria-labelledby={`${id}-new`}>
        <h2 id={`${id}-new`}>{editing ? 'Editar comunicado programado' : 'Nuevo comunicado'}</h2>
        <form className="announcement-form" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={`${id}-author`}>Remitente</label>
            <input
              id={`${id}-author`}
              type="text"
              value={draft.authorName}
              maxLength={80}
              aria-invalid={issue('authorName') ? true : undefined}
              onChange={(e) => set({ authorName: e.target.value })}
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
              onChange={(e) => set({ title: e.target.value })}
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
              onChange={(e) => set({ body: e.target.value })}
            />
            <span id={`${id}-count`} className="muted small">
              {draft.body.length} / {MAX_ANNOUNCEMENT_BODY}
            </span>
            {issue('body') ? <span className="field-error">{issue('body')}</span> : null}
          </div>

          <div className="delivery-grid">
            <fieldset className="delivery">
              <legend>Para quién</legend>
              <div className="segmented" role="group" aria-label="Para quién">
                <button type="button" className={draft.toGroups ? '' : 'active'} aria-pressed={!draft.toGroups} onClick={() => set({ toGroups: false })}>
                  Todo el equipo
                </button>
                <button type="button" className={draft.toGroups ? 'active' : ''} aria-pressed={draft.toGroups} onClick={() => set({ toGroups: true })}>
                  Algunos grupos
                </button>
              </div>
              {draft.toGroups ? (
                groups.length === 0 ? (
                  <p className="muted small">
                    Aún no hay grupos. <Link to="/colaboradores/grupos">Crea uno en Colaboradores › Grupos</Link>.
                  </p>
                ) : (
                  <ul className="group-chips" aria-label="Grupos">
                    {groups.map((g) => {
                      const on = draft.groupIds.includes(g.id);
                      const n = people.filter((p) => g.memberUids.includes(p.id)).length;
                      return (
                        <li key={g.id}>
                          <label className={`group-chip${on ? ' on' : ''}`}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={(e) =>
                                set({ groupIds: e.target.checked ? [...draft.groupIds, g.id] : draft.groupIds.filter((x) => x !== g.id) })
                              }
                            />
                            <span>{g.name}</span>
                            <span className="muted small">{n}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : null}
              <span className="muted small" aria-live="polite">
                {draft.toGroups && draft.groupIds.length === 0
                  ? 'Elige uno o más grupos.'
                  : `Llega a ${recipients.length === 1 ? '1 persona activa' : `${recipients.length} personas activas`}.`}
              </span>
              {issue('groupIds') ? <span className="field-error">{issue('groupIds')}</span> : null}
            </fieldset>

            <fieldset className="delivery">
              <legend>Cuándo</legend>
              <div className="segmented" role="group" aria-label="Cuándo">
                <button type="button" className={draft.scheduled ? '' : 'active'} aria-pressed={!draft.scheduled} disabled={editing !== null} onClick={() => set({ scheduled: false })}>
                  Enviar ahora
                </button>
                <button
                  type="button"
                  className={draft.scheduled ? 'active' : ''}
                  aria-pressed={draft.scheduled}
                  onClick={() => set({ scheduled: true, when: draft.when || toLocalInput(defaultScheduleTime(Date.now())) })}
                >
                  Programar
                </button>
              </div>
              {draft.scheduled ? (
                <div className="field">
                  <label htmlFor={`${id}-when`}>Fecha y hora de envío</label>
                  <input
                    id={`${id}-when`}
                    type="datetime-local"
                    value={draft.when}
                    min={toLocalInput(now)}
                    aria-invalid={issue('publishAt') ? true : undefined}
                    onChange={(e) => set({ when: e.target.value })}
                  />
                  {issue('publishAt') ? <span className="field-error">{issue('publishAt')}</span> : null}
                </div>
              ) : null}
            </fieldset>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn primary">
              {editing ? 'Guardar cambios' : draft.scheduled ? 'Programar envío' : 'Publicar'}
            </button>
            {editing ? (
              <button type="button" className="btn" onClick={reset}>
                Cancelar edición
              </button>
            ) : null}
          </div>
        </form>
      </section>

      {scheduled.length > 0 ? (
        <section className="card flush" aria-labelledby={`${id}-scheduled`}>
          <h2 id={`${id}-scheduled`} className="card-title">
            Programados
          </h2>
          <ul className="list">
            {scheduled.map((a) => (
              <li key={a.id} className={`list-item announcement-item${editing?.id === a.id ? ' editing' : ''}`}>
                <div className="list-main">
                  <span className="person-name">{a.title}</span>
                  <span className="muted small">
                    {a.authorName} · se envía {formatRelativeDateTime(announcementPublishAt(a), now)}
                  </span>
                </div>
                <div className="list-actions">
                  <span className="chip">{audienceLabel(a, groups)}</span>
                  <span className="chip">{peopleCount(recipientsOf(a, people).length)}</span>
                  <button type="button" className="btn small-btn" onClick={() => startEdit(a)} aria-label={`Editar «${a.title}»`}>
                    Editar
                  </button>
                  <button
                    type="button"
                    className="btn small-btn"
                    onClick={() => {
                      setNotice(null);
                      setError(null);
                      setSendingNow(a);
                    }}
                    aria-label={`Enviar ahora «${a.title}»`}
                  >
                    Enviar ahora
                  </button>
                  <button
                    type="button"
                    className="btn small-btn danger-outline"
                    onClick={() => {
                      setNotice(null);
                      setError(null);
                      setDeleting(a);
                    }}
                    aria-label={`Eliminar «${a.title}»`}
                  >
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card flush" aria-labelledby={`${id}-list`}>
        <h2 id={`${id}-list`} className="card-title">
          Publicados
        </h2>
        {load.error && !load.data ? (
          <ErrorState error={load.error} onRetry={load.reload} />
        ) : !load.data ? (
          <Loading />
        ) : sent.length === 0 ? (
          <Empty title={scheduled.length > 0 ? 'Aún no se envía ninguno' : 'Aún no hay comunicados'}>
            {scheduled.length > 0 ? 'Los programados aparecen aquí cuando llega su hora.' : 'Escribe el primero en el formulario de arriba.'}
          </Empty>
        ) : (
          <ul className="list">
            {sent.map((a) => (
              <AnnouncementItem
                key={a.id}
                announcement={a}
                people={recipientsOf(a, people)}
                audience={audienceLabel(a, groups)}
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
          title={editing ? 'Guardar cambios' : publishAt === null ? 'Publicar comunicado' : 'Programar comunicado'}
          message={
            <p>
              «{draft.title.trim()}» {publishAt === null ? 'llegará ahora' : `se enviará ${confirmWhen}`} como notificación a{' '}
              {peopleCount(recipients.length)} ({confirmTo}).{' '}
              {publishAt === null
                ? 'Una vez publicado no se puede editar: solo archivar o eliminar.'
                : 'Hasta esa hora puedes editarlo, enviarlo antes o eliminarlo.'}
            </p>
          }
          confirmLabel={editing ? 'Guardar' : publishAt === null ? 'Publicar' : 'Programar'}
          busy={busy}
          error={error}
          onConfirm={() => void publish()}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
        />
      ) : null}
      {sendingNow ? (
        <ConfirmDialog
          title="Enviar ahora"
          message={
            <p>
              «{sendingNow.title}» llegará ahora a {peopleCount(recipientsOf(sendingNow, people).length)} en vez de{' '}
              {formatRelativeDateTime(announcementPublishAt(sendingNow), now)}. Después ya no se puede editar.
            </p>
          }
          confirmLabel="Enviar ahora"
          busy={busy}
          error={error}
          onConfirm={() => void sendNow()}
          onCancel={() => {
            setSendingNow(null);
            setError(null);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Eliminar comunicado"
          message={
            isScheduled(deleting, now) && deleting.archivedAt === null ? (
              <p>«{deleting.title}» no se enviará.</p>
            ) : (
              <p>«{deleting.title}» y sus confirmaciones de lectura dejarán de verse. Si solo quieres que deje de aparecer en la extensión, archívalo.</p>
            )
          }
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
  /** Its recipients among the active people. */
  people: readonly WithId<UserProfile>[];
  /** "Todo el equipo" or its groups. */
  audience: string;
  reads: readonly AnnouncementRead[];
  open: boolean;
  onToggle(): void;
  onArchive(archivedAt: number | null): Promise<void>;
  onDelete(): void;
}

function AnnouncementItem({ announcement: a, people, audience, reads, open, onToggle, onArchive, onDelete }: ItemProps) {
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
          {a.authorName} · {formatRelativeDateTime(announcementPublishAt(a), now)} · {audience}
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

