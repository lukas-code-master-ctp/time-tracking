import { useId, useState } from 'react';
import {
  ABSENCE_STATUS_LABELS,
  ABSENCE_TYPES,
  ABSENCE_TYPE_LABELS,
  MAX_ABSENCE_NOTE,
  absenceStatus,
  type Absence,
  type AbsenceStatus,
  type AbsenceType,
  type WithId,
} from '@timetracking/shared';
import { absenceTitle, absenceToForm, emptyAbsenceForm, sortAbsences, validateAbsenceForm, type AbsenceForm } from '../lib/absences';
import { errorMessage } from '../lib/messages';
import { Link } from 'react-router';
import { ConfirmDialog, Modal } from './Modal';

interface Props {
  /** Absences of the person (any dates). */
  absences: readonly WithId<Absence>[];
  /** Day being looked at: the default date of a new absence. */
  date: string;
  onSave(id: string | null, form: AbsenceForm, existing: Absence | null): Promise<void>;
  onDelete(id: string): Promise<void>;
  /** Approves or rejects a pending request. */
  onDecide(absence: WithId<Absence>, status: Exclude<AbsenceStatus, 'pending'>): Promise<void>;
}

const STATUS_CHIP: Record<AbsenceStatus, string> = { pending: 'warn', approved: 'ok', rejected: 'muted-chip' };

/** "Pendiente" / "Aprobada" / "Rechazada". Approved ones recorded by an admin show nothing unless `always`. */
export function AbsenceStatusChip({ absence, always = false }: { absence: Absence; always?: boolean }) {
  const status = absenceStatus(absence);
  if (status === 'approved' && !always && absence.createdBy !== absence.uid) return null;
  return <span className={`chip small-chip ${STATUS_CHIP[status]}`}>{ABSENCE_STATUS_LABELS[status]}</span>;
}

/** "Aprobar" / "Rechazar" of a pending request. */
export function DecisionButtons({
  absence,
  onDecide,
}: {
  absence: WithId<Absence>;
  onDecide(absence: WithId<Absence>, status: Exclude<AbsenceStatus, 'pending'>): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (status: Exclude<AbsenceStatus, 'pending'>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(absence, status);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn primary" disabled={busy} onClick={() => void decide('approved')} aria-label={`Aprobar ${absenceTitle(absence)}`}>
        Aprobar
      </button>
      <button type="button" className="btn" disabled={busy} onClick={() => void decide('rejected')} aria-label={`Rechazar ${absenceTitle(absence)}`}>
        Rechazar
      </button>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

/**
 * "Ausencias justificadas" of the collaborator page (spec
 * 2026-10-22-ausencias-justificadas): the list, "Agregar ausencia", and
 * editing or deleting each one. Requests made from the extension show their
 * status, and the pending ones can be approved or rejected here.
 */
export function AbsencesSection({ absences, date, onSave, onDelete, onDecide }: Props) {
  const [editing, setEditing] = useState<{ id: string | null; existing: Absence | null; form: AbsenceForm } | null>(null);
  const [deleting, setDeleting] = useState<WithId<Absence> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sorted = sortAbsences(absences);

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(deleting.id);
      setDeleting(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="h-absences">
      <div className="card-head">
        <h2 id="h-absences">Ausencias justificadas</h2>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setError(null);
            setEditing({ id: null, existing: null, form: emptyAbsenceForm(date) });
          }}
        >
          Agregar ausencia
        </button>
      </div>
      {sorted.length === 0 ? (
        <p className="muted">
          No hay ausencias registradas. Registra vacaciones, licencias, trámites o permisos para que ese tiempo no cuente como
          ausencia, atraso ni sin conexión.
        </p>
      ) : (
        <ul className="absence-list" data-testid="absence-list">
          {sorted.map((a) => (
            <li key={a.id}>
              <div className="absence-text">
                <span className="strong">
                  {absenceTitle(a)} <AbsenceStatusChip absence={a} />
                </span>
                {a.note ? <span className="muted small">{a.note}</span> : null}
                {a.createdBy === a.uid ? <span className="muted small">Solicitada desde la extensión</span> : null}
              </div>
              <div className="row-actions">
                {absenceStatus(a) === 'pending' ? <DecisionButtons absence={a} onDecide={onDecide} /> : null}
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setError(null);
                    setEditing({ id: a.id, existing: a, form: absenceToForm(a) });
                  }}
                  aria-label={`Editar ${absenceTitle(a)}`}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setError(null);
                    setDeleting(a);
                  }}
                  aria-label={`Eliminar ${absenceTitle(a)}`}
                >
                  Eliminar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <AbsenceDialog
          initial={editing.form}
          isNew={editing.id === null}
          onCancel={() => setEditing(null)}
          onSave={async (form) => {
            await onSave(editing.id, form, editing.existing);
            setEditing(null);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Eliminar ausencia"
          message={<p>¿Eliminar “{absenceTitle(deleting)}”? Ese tiempo volverá a contar como ausencia, atraso o sin conexión.</p>}
          confirmLabel="Eliminar"
          danger
          busy={busy}
          error={error}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * "Solicitudes de ausencia" of the team page: the requests made from the
 * extension waiting for an admin (spec 2026-10-22-solicitud-ausencias).
 * Nothing is shown while there are none.
 */
export function PendingRequests({
  requests,
  names,
  hrefOf,
  onDecide,
}: {
  requests: readonly WithId<Absence>[];
  /** uid → name shown. */
  names: ReadonlyMap<string, string>;
  /** Collaborator page of a request (opened on its first day). */
  hrefOf(absence: Absence): string;
  onDecide(absence: WithId<Absence>, status: Exclude<AbsenceStatus, 'pending'>): Promise<void>;
}) {
  if (requests.length === 0) return null;
  const sorted = [...requests].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <section className="card" aria-labelledby="h-requests">
      <h2 id="h-requests">
        Solicitudes de ausencia <span className="chip warn small-chip">{sorted.length} pendiente{sorted.length === 1 ? '' : 's'}</span>
      </h2>
      <ul className="absence-list" data-testid="pending-requests">
        {sorted.map((a) => (
          <li key={a.id}>
            <div className="absence-text">
              <span className="strong">
                <Link to={hrefOf(a)}>{names.get(a.uid) ?? 'Colaborador'}</Link> · {absenceTitle(a)}
              </span>
              {a.note ? <span className="muted small">{a.note}</span> : null}
            </div>
            <div className="row-actions">
              <DecisionButtons absence={a} onDecide={onDecide} />
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">Solo las ausencias aprobadas justifican tiempo en los reportes.</p>
    </section>
  );
}

interface DialogProps {
  initial: AbsenceForm;
  isNew: boolean;
  onSave(form: AbsenceForm): Promise<void>;
  onCancel(): void;
}

export function AbsenceDialog({ initial, isNew, onSave, onCancel }: DialogProps) {
  const id = useId();
  const [form, setForm] = useState<AbsenceForm>(initial);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issues = validateAbsenceForm(form);
  const messages = touched ? [...new Set(issues.map((i) => i.message))] : [];
  const set = (patch: Partial<AbsenceForm>): void => setForm((f) => ({ ...f, ...patch }));

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (issues.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={isNew ? 'Agregar ausencia' : 'Editar ausencia'} onClose={busy ? () => undefined : onCancel}>
      <form
        className="modal-body absence-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-type`}>Tipo</label>
          <select id={`${id}-type`} value={form.type} onChange={(e) => set({ type: e.target.value as AbsenceType })} data-autofocus>
            {ABSENCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {ABSENCE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="segmented" role="group" aria-label="Duración">
          {(
            [
              ['days', 'Días completos'],
              ['hours', 'Por horas'],
            ] as const
          ).map(([mode, label]) => (
            <button key={mode} type="button" className={form.mode === mode ? 'active' : ''} aria-pressed={form.mode === mode} onClick={() => set({ mode })}>
              {label}
            </button>
          ))}
        </div>
        {form.mode === 'days' ? (
          <div className="field-row">
            <div className="field">
              <label htmlFor={`${id}-from`}>Desde</label>
              <input
                id={`${id}-from`}
                type="date"
                value={form.startDate}
                onChange={(e) => set({ startDate: e.target.value, endDate: form.endDate < e.target.value ? e.target.value : form.endDate })}
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-to`}>Hasta (inclusive)</label>
              <input id={`${id}-to`} type="date" value={form.endDate} min={form.startDate} onChange={(e) => set({ endDate: e.target.value })} />
            </div>
          </div>
        ) : (
          <div className="field-row">
            <div className="field">
              <label htmlFor={`${id}-day`}>Día</label>
              <input id={`${id}-day`} type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-start`}>Desde</label>
              <input id={`${id}-start`} type="time" value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-end`}>Hasta</label>
              <input id={`${id}-end`} type="time" value={form.endTime} onChange={(e) => set({ endTime: e.target.value })} />
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor={`${id}-note`}>Comentario{form.type === 'other' ? '' : ' (opcional)'}</label>
          <textarea
            id={`${id}-note`}
            rows={3}
            maxLength={MAX_ABSENCE_NOTE}
            value={form.note}
            placeholder="Ej.: licencia N° 12345, trámite en el registro civil…"
            onChange={(e) => set({ note: e.target.value })}
          />
        </div>
        {messages.length > 0 ? (
          <ul className="field-error" role="alert">
            {messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
