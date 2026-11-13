import { useId, useState } from 'react';
import {
  MAX_GROUP_NAME,
  sortGroups,
  validateGroup,
  type PersonGroup,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { ConfirmDialog, Modal } from '../components/Modal';
import { PeopleTabs } from '../components/PeopleTabs';
import { initials } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import type { DataSource } from '../data/types';
import { errorMessage } from '../lib/messages';
import { useLoad } from '../lib/useLoad';

const nameOf = (u: UserProfile): string => u.displayName || u.email;

/** Names of the first members, for the list ("Ana, Beto y 3 más"). */
function membersLabel(uids: readonly string[], names: ReadonlyMap<string, string>): string {
  const known = uids.flatMap((u) => (names.has(u) ? [names.get(u)!] : []));
  if (known.length === 0) return 'Sin personas activas';
  const shown = known.slice(0, 3);
  const rest = known.length - shown.length;
  if (rest === 0) return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')} y ${shown[shown.length - 1]}`;
  return `${shown.join(', ')} y ${rest} más`;
}

export interface GroupsPageProps {
  /**
   * Called after a group is saved, so features that copy its members (the
   * scheduled announcements) can follow the change. Failures are shown.
   */
  onGroupSaved?(data: DataSource, groupId: string, group: PersonGroup): Promise<void>;
}

/**
 * Colaboradores › Grupos (spec 2026-11-13-grupos-y-comunicados-agendados):
 * named groups of people, used to send an announcement to part of the team
 * (and by other features that apply only to some people).
 */
export function GroupsPage({ onGroupSaved }: GroupsPageProps) {
  const data = useData();
  const { uid: me } = useAdmin();
  const load = useLoad(async () => {
    const [groups, users] = await Promise.all([data.listGroups(), data.listUsers()]);
    const people = users.filter((u) => u.status === 'active').sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'es'));
    return { groups: sortGroups(groups), people };
  }, [data]);
  const [editing, setEditing] = useState<WithId<PersonGroup> | 'new' | null>(null);
  const [deleting, setDeleting] = useState<WithId<PersonGroup> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const people = load.data?.people ?? [];
  const names = new Map(people.map((p) => [p.id, nameOf(p)]));

  const save = async (draft: { name: string; memberUids: string[] }): Promise<void> => {
    const now = Date.now();
    const prev = editing === 'new' ? null : editing;
    const group: PersonGroup = {
      name: draft.name.trim(),
      memberUids: draft.memberUids,
      createdAt: prev?.createdAt ?? now,
      createdBy: prev?.createdBy ?? me,
      updatedAt: now,
      updatedBy: me,
    };
    const id = await data.saveGroup(prev?.id ?? null, group);
    await onGroupSaved?.(data, id, group);
    setEditing(null);
    setNotice(prev ? `Grupo «${group.name}» actualizado.` : `Grupo «${group.name}» creado.`);
    load.reload();
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await data.deleteGroup(deleting.id);
      setNotice(`Grupo «${deleting.name}» eliminado.`);
      setDeleting(null);
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
        title="Colaboradores"
        subtitle="Arma grupos de personas (por ejemplo, Terreno o Jefaturas) para enviarles comunicados solo a ellas."
      />
      <PeopleTabs />
      {notice ? (
        <p className="banner ok" role="status">
          {notice}
        </p>
      ) : null}
      <section className="card flush" aria-labelledby="groups-title">
        <div className="card-head padded">
          <h2 id="groups-title">Grupos</h2>
          <button
            type="button"
            className="btn primary"
            disabled={!load.data}
            onClick={() => {
              setNotice(null);
              setEditing('new');
            }}
          >
            Nuevo grupo
          </button>
        </div>
        {load.error && !load.data ? (
          <ErrorState error={load.error} onRetry={load.reload} />
        ) : !load.data ? (
          <Loading />
        ) : load.data.groups.length === 0 ? (
          <Empty title="Aún no hay grupos">Crea uno para enviar comunicados solo a una parte del equipo.</Empty>
        ) : (
          <ul className="list">
            {load.data.groups.map((g) => {
              const active = g.memberUids.filter((u) => names.has(u)).length;
              return (
                <li key={g.id} className="list-item group-item">
                  <div className="list-main">
                    <span className="person-name">{g.name}</span>
                    <span className="muted small">{membersLabel(g.memberUids, names)}</span>
                  </div>
                  <div className="list-actions">
                    <span className="chip">{active === 1 ? '1 persona' : `${active} personas`}</span>
                    <button
                      type="button"
                      className="btn small-btn"
                      aria-label={`Editar «${g.name}»`}
                      onClick={() => {
                        setNotice(null);
                        setEditing(g);
                      }}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="btn small-btn danger-outline"
                      aria-label={`Eliminar «${g.name}»`}
                      onClick={() => {
                        setNotice(null);
                        setError(null);
                        setDeleting(g);
                      }}
                    >
                      Eliminar
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {editing ? (
        <GroupDialog
          group={editing === 'new' ? null : editing}
          others={(load.data?.groups ?? []).filter((g) => editing === 'new' || g.id !== editing.id)}
          people={people}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Eliminar grupo"
          message={<p>«{deleting.name}» dejará de existir. Los comunicados ya enviados a este grupo no cambian.</p>}
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

interface DialogProps {
  group: WithId<PersonGroup> | null;
  others: readonly PersonGroup[];
  people: readonly WithId<UserProfile>[];
  onSave(draft: { name: string; memberUids: string[] }): Promise<void>;
  onCancel(): void;
}

function GroupDialog({ group, others, people, onSave, onCancel }: DialogProps) {
  const id = useId();
  const activeIds = new Set(people.map((p) => p.id));
  // Members who are not active now (disabled) stay in the group, unseen.
  const hidden = (group?.memberUids ?? []).filter((u) => !activeIds.has(u));
  const [name, setName] = useState(group?.name ?? '');
  const [picked, setPicked] = useState<Set<string>>(() => new Set((group?.memberUids ?? []).filter((u) => activeIds.has(u))));
  const [filter, setFilter] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberUids = [...people.filter((p) => picked.has(p.id)).map((p) => p.id), ...hidden];
  const issues = validateGroup({ name, memberUids: people.some((p) => picked.has(p.id)) ? memberUids : [] }, others);
  const issue = (path: string): string | undefined => (touched ? issues.find((i) => i.path === path)?.message : undefined);
  const q = filter.trim().toLocaleLowerCase('es');
  const shown = q === '' ? people : people.filter((p) => `${p.displayName} ${p.email}`.toLocaleLowerCase('es').includes(q));
  const allShown = shown.length > 0 && shown.every((p) => picked.has(p.id));

  const toggle = (uid: string, on: boolean): void =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(uid);
      else next.delete(uid);
      return next;
    });

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (issues.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ name, memberUids });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={group ? 'Editar grupo' : 'Nuevo grupo'} onClose={busy ? () => undefined : onCancel}>
      <form
        className="modal-body group-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-name`}>Nombre</label>
          <input
            id={`${id}-name`}
            type="text"
            value={name}
            maxLength={MAX_GROUP_NAME}
            placeholder="Ej.: Terreno"
            aria-invalid={issue('name') ? true : undefined}
            onChange={(e) => setName(e.target.value)}
            data-autofocus
          />
          {issue('name') ? <span className="field-error">{issue('name')}</span> : null}
        </div>
        <fieldset className="group-members">
          <legend>
            Personas <span className="muted small">({picked.size} elegidas)</span>
          </legend>
          <div className="group-members-tools">
            <input type="search" placeholder="Buscar por nombre o correo" aria-label="Buscar personas" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button
              type="button"
              className="btn small-btn"
              disabled={shown.length === 0}
              onClick={() =>
                setPicked((s) => {
                  const next = new Set(s);
                  for (const p of shown) {
                    if (allShown) next.delete(p.id);
                    else next.add(p.id);
                  }
                  return next;
                })
              }
            >
              {allShown ? 'Quitar todas' : 'Elegir todas'}
            </button>
          </div>
          {people.length === 0 ? (
            <p className="muted small">No hay personas activas.</p>
          ) : shown.length === 0 ? (
            <p className="muted small">Nadie coincide con «{filter.trim()}».</p>
          ) : (
            <ul className="group-pick-list">
              {shown.map((p) => (
                <li key={p.id}>
                  <label className="group-pick">
                    <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
                    <span className="avatar small-avatar" aria-hidden="true">
                      {initials(nameOf(p))}
                    </span>
                    <span className="read-name">{nameOf(p)}</span>
                    {p.displayName ? <span className="muted small group-pick-email">{p.email}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {issue('memberUids') ? <span className="field-error">{issue('memberUids')}</span> : null}
        </fieldset>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Guardando…' : group ? 'Guardar cambios' : 'Crear grupo'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
