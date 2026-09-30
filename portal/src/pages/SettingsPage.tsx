import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MAX_ALLOWED_DOMAINS, allowedDomainsOr, emailDomain, type OrgConfig, type ScheduleConfig } from '@timetracking/shared';
import { ConfirmDialog } from '../components/Modal';
import { ScheduleConfigForm } from '../components/ScheduleEditor';
import { ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { ALLOWED_DOMAINS } from '../env';
import { formatRelativeDateTime, zonedDate } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import {
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  addDomain,
  buildOrgConfig,
  canRemoveDomain,
  orgConfigToForm,
  validateOrgConfig,
  type FieldErrors,
  type OrgConfigForm,
} from '../lib/payloads';
import { DEFAULT_WEEK, buildScheduleConfig, defaultScheduleForm, describeWeek, scheduleToForm, type ScheduleForm } from '../lib/schedule';
import { useLoad } from '../lib/useLoad';

interface FormProps {
  config: OrgConfig | null;
  /** Email of the signed-in admin: the domain of their own account cannot be removed. */
  adminEmail?: string | null;
  /** Receives the form; builds and saves the document. Throws on failure. */
  onSave(form: OrgConfigForm): Promise<void>;
}

export function SettingsForm({ config, adminEmail = null, onSave }: FormProps) {
  const id = useId();
  const [form, setForm] = useState<OrgConfigForm>(() => orgConfigToForm(config, ALLOWED_DOMAINS));
  const [errors, setErrors] = useState<FieldErrors<keyof OrgConfigForm>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [editDomains, setEditDomains] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => setForm(orgConfigToForm(config, ALLOWED_DOMAINS)), [config]);

  const set = <K extends keyof OrgConfigForm>(key: K, value: OrgConfigForm[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setStatus(null);
  };

  const ownDomain = adminEmail ? emailDomain(adminEmail) : null;

  const add = (): void => {
    const res = addDomain(form.allowedDomains, newDomain);
    if (!res.ok) {
      setAddError(res.error);
      return;
    }
    set('allowedDomains', res.domains);
    setNewDomain('');
    setAddError(null);
  };

  const onAddKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Enter adds the domain instead of submitting the whole form.
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  };

  const remove = (domain: string): void => {
    if (!canRemoveDomain(form.allowedDomains, domain, adminEmail)) return;
    set(
      'allowedDomains',
      form.allowedDomains.filter((d) => d !== domain),
    );
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const found = validateOrgConfig(form, adminEmail);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await onSave(form);
      setStatus({ ok: true, text: 'Configuración guardada. La extensión la aplica en unos minutos.' });
      setEditDomains(false);
      setNewDomain('');
      setAddError(null);
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const saved = allowedDomainsOr(config, ALLOWED_DOMAINS);
  const domainsChanged = config !== null && form.allowedDomains.join(',') !== saved.join(',');

  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)} noValidate>
      <fieldset>
        <legend>Capturas de pantalla</legend>
        <label className="switch-row" htmlFor={`${id}-shots`}>
          <input
            id={`${id}-shots`}
            type="checkbox"
            checked={form.screenshotsEnabled}
            onChange={(e) => set('screenshotsEnabled', e.target.checked)}
          />
          <span>
            <span className="strong">Tomar capturas</span>
            <span className="muted small block">Una captura de la pestaña visible por cada bloque de 10 minutos, en un instante al azar.</span>
          </span>
        </label>
        <label className="switch-row" htmlFor={`${id}-blur`}>
          <input
            id={`${id}-blur`}
            type="checkbox"
            checked={form.blurScreenshots}
            onChange={(e) => set('blurScreenshots', e.target.checked)}
          />
          <span>
            <span className="strong">Difuminar capturas</span>
            <span className="muted small block">Se difuminan en el computador del colaborador antes de subirlas.</span>
          </span>
        </label>
        <div className="field">
          <label htmlFor={`${id}-ret`}>Conservar capturas (días)</label>
          <input
            id={`${id}-ret`}
            type="number"
            inputMode="numeric"
            min={MIN_RETENTION_DAYS}
            max={MAX_RETENTION_DAYS}
            step={1}
            value={form.screenshotRetentionDays}
            onChange={(e) => set('screenshotRetentionDays', e.target.value)}
            aria-invalid={errors.screenshotRetentionDays ? true : undefined}
            aria-describedby={`${id}-ret-help${errors.screenshotRetentionDays ? ` ${id}-ret-err` : ''}`}
          />
          <p id={`${id}-ret-help`} className="muted small">
            Entre {MIN_RETENTION_DAYS} y {MAX_RETENTION_DAYS}. Las capturas más antiguas se borran cada noche; las horas y la
            actividad se conservan.
          </p>
          {errors.screenshotRetentionDays ? (
            <p id={`${id}-ret-err`} className="field-error" role="alert">
              {errors.screenshotRetentionDays}
            </p>
          ) : null}
        </div>
      </fieldset>

      <fieldset aria-describedby={`${id}-domains-help${errors.allowedDomains ? ` ${id}-domains-err` : ''}`}>
        <legend>Dominios permitidos</legend>
        <p id={`${id}-domains-help`} className="muted small">
          Solo las cuentas de estos dominios de Google Workspace pueden unirse e invitarse (máximo {MAX_ALLOWED_DOMAINS}).
        </p>
        <ul className="domain-list" aria-label="Dominios permitidos">
          {form.allowedDomains.map((d) => (
            <li key={d} className="domain-item">
              <span className="domain-name">@{d}</span>
              {d === ownDomain ? <span className="chip small-chip">tu cuenta</span> : null}
              {editDomains ? (
                <button
                  type="button"
                  className="btn small-btn"
                  onClick={() => remove(d)}
                  disabled={!canRemoveDomain(form.allowedDomains, d, adminEmail)}
                  aria-label={`Quitar @${d}`}
                  title={
                    d === ownDomain
                      ? 'No puedes quitar el dominio de tu propia cuenta.'
                      : form.allowedDomains.length <= 1
                        ? 'Debe quedar al menos un dominio.'
                        : undefined
                  }
                >
                  Quitar
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {!editDomains ? (
          <div>
            <button type="button" className="btn" onClick={() => setEditDomains(true)}>
              Cambiar dominios
            </button>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor={`${id}-add`}>Agregar dominio</label>
              <div className="input-row">
                <input
                  id={`${id}-add`}
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="empresa.cl"
                  value={newDomain}
                  onChange={(e) => {
                    setNewDomain(e.target.value);
                    setAddError(null);
                  }}
                  onKeyDown={onAddKey}
                  aria-invalid={addError ? true : undefined}
                  aria-describedby={addError ? `${id}-add-err` : undefined}
                />
                <button type="button" className="btn" onClick={add}>
                  Agregar
                </button>
              </div>
              {addError ? (
                <p id={`${id}-add-err`} className="field-error" role="alert">
                  {addError}
                </p>
              ) : null}
            </div>
            <p className="banner warn">
              Cuidado: si quitas un dominio, las personas de ese dominio ya no podrán unirse ni ser invitadas. Quienes ya son
              colaboradores mantienen su acceso. No puedes quitar el dominio de tu propia cuenta ni dejar la lista vacía.
            </p>
          </>
        )}
        {errors.allowedDomains ? (
          <p id={`${id}-domains-err`} className="field-error" role="alert">
            {errors.allowedDomains}
          </p>
        ) : null}
      </fieldset>

      {status ? (
        <p className={`banner ${status.ok ? 'ok' : 'error'}`} role={status.ok ? 'status' : 'alert'}>
          {status.text}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Guardando…' : domainsChanged ? 'Guardar y cambiar dominios' : 'Guardar cambios'}
        </button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const data = useData();
  const { uid, profile } = useAdmin();
  const load = useLoad(() => data.getOrgConfig(), [data]);
  const schedule = useLoad(() => data.getScheduleConfig(), [data]);

  return (
    <>
      <PageHeader
        title="Configuración"
        subtitle={
          load.data
            ? `Última modificación ${formatRelativeDateTime(load.data.updatedAt, Date.now())}${load.data.updatedBy === uid ? ' (por ti)' : ''}`
            : 'Ajustes de la organización'
        }
      />
      <section className="card">
        {load.error && load.data === undefined ? (
          <ErrorState error={load.error} onRetry={load.reload} />
        ) : load.data === undefined ? (
          <Loading />
        ) : (
          <SettingsForm
            config={load.data}
            adminEmail={profile.email}
            onSave={async (form) => {
              await data.saveOrgConfig(buildOrgConfig(form, uid, Date.now(), profile.email));
              load.reload();
            }}
          />
        )}
      </section>
      <section className="card" aria-labelledby="h-schedule">
        <h2 id="h-schedule">Horario</h2>
        {schedule.error && schedule.data === undefined ? (
          <ErrorState error={schedule.error} onRetry={schedule.reload} />
        ) : schedule.data === undefined ? (
          <Loading label="Cargando el horario…" />
        ) : (
          <ScheduleSection
            config={schedule.data}
            uid={uid}
            now={Date.now()}
            onSave={async (form) => {
              await data.saveScheduleConfig(buildScheduleConfig(form, uid, Date.now()));
              schedule.reload();
            }}
            onDelete={async () => {
              await data.deleteScheduleConfig();
              schedule.reload();
            }}
          />
        )}
      </section>
    </>
  );
}

interface ScheduleSectionProps {
  /** Saved general schedule (null = none). */
  config: ScheduleConfig | null;
  uid: string;
  now: number;
  onSave(form: ScheduleForm): Promise<void>;
  onDelete(): Promise<void>;
}

/**
 * "Configuración → Horario". Without a schedule it explains what that means
 * and offers to create one with suggested values, which the admin reviews
 * before saving (nothing is written until then).
 */
export function ScheduleSection({ config, uid, now, onSave, onDelete }: ScheduleSectionProps) {
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const today = zonedDate(now);

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      setConfirmDelete(false);
      setCreating(false);
      setNotice('Horario eliminado. La extensión vuelve a medir siempre que la jornada esté abierta.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {notice ? (
        <p className="banner ok" role="status">
          {notice}
        </p>
      ) : null}
      {config ? (
        <>
          <p className="muted small schedule-meta">
            Última modificación {formatRelativeDateTime(config.updatedAt, now)}
            {config.updatedBy === uid ? ' (por ti)' : ''}.
          </p>
          <ScheduleConfigForm
            initial={scheduleToForm(config)}
            isNew={false}
            today={today}
            onSave={async (form) => {
              setNotice(null);
              await onSave(form);
            }}
            onDelete={() => {
              setNotice(null);
              setError(null);
              setConfirmDelete(true);
            }}
          />
        </>
      ) : creating ? (
        <ScheduleConfigForm
          initial={defaultScheduleForm()}
          isNew
          today={today}
          onSave={async (form) => {
            setNotice(null);
            await onSave(form);
            setCreating(false);
            setNotice('Horario creado. La extensión lo aplica en unos minutos.');
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <div className="schedule-empty" data-testid="schedule-empty">
          <p className="state-title">Sin horario configurado</p>
          <p className="muted">
            Hoy la extensión mide siempre que la jornada esté abierta, a cualquier hora. No hay reportes de cumplimiento
            (atrasos, ausencias, tiempo fuera de horario) ni recordatorios.
          </p>
          <p className="muted">
            Al crear un horario te sugerimos: {describeWeek(DEFAULT_WEEK).join(' · ')}; feriados
            de Chile 2026–2027, 5 minutos de tolerancia y recordatorios activados. Podrás revisarlo antes de guardar.
          </p>
          <div>
            <button type="button" className="btn primary" onClick={() => {
                setNotice(null);
                setCreating(true);
              }}>
              Crear horario
            </button>
          </div>
        </div>
      )}
      {confirmDelete ? (
        <ConfirmDialog
          title="Eliminar horario"
          message={
            <>
              <p>
                La organización quedará <strong>sin horario</strong>: la extensión volverá a medir siempre que la jornada esté
                abierta, sin recordatorios, y Equipo dejará de mostrar el cumplimiento (también de días pasados).
              </p>
              <p>Los horarios personalizados de Colaboradores se mantienen, pero sin feriados ni recordatorios.</p>
            </>
          }
          confirmLabel="Eliminar horario"
          danger
          busy={busy}
          error={error}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </>
  );
}
