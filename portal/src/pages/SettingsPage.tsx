import { useEffect, useId, useState, type FormEvent } from 'react';
import { normalizeDomain, type OrgConfig } from '@timetracking/shared';
import { ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { ALLOWED_DOMAIN } from '../env';
import { formatRelativeDateTime } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import {
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  buildOrgConfig,
  orgConfigToForm,
  validateOrgConfig,
  type FieldErrors,
  type OrgConfigForm,
} from '../lib/payloads';
import { useLoad } from '../lib/useLoad';

interface FormProps {
  config: OrgConfig | null;
  /** Receives the form; builds and saves the document. Throws on failure. */
  onSave(form: OrgConfigForm): Promise<void>;
}

export function SettingsForm({ config, onSave }: FormProps) {
  const id = useId();
  const [form, setForm] = useState<OrgConfigForm>(() => orgConfigToForm(config, ALLOWED_DOMAIN));
  const [errors, setErrors] = useState<FieldErrors<keyof OrgConfigForm>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [editDomain, setEditDomain] = useState(false);

  useEffect(() => setForm(orgConfigToForm(config, ALLOWED_DOMAIN)), [config]);

  const set = <K extends keyof OrgConfigForm>(key: K, value: OrgConfigForm[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setStatus(null);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const found = validateOrgConfig(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await onSave(form);
      setStatus({ ok: true, text: 'Configuración guardada. La extensión la aplica en unos minutos.' });
      setEditDomain(false);
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const domainChanged = config !== null && normalizeDomain(form.allowedDomain) !== config.allowedDomain;

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

      <fieldset>
        <legend>Dominio permitido</legend>
        <div className="field">
          <label htmlFor={`${id}-domain`}>Dominio de Google Workspace</label>
          <div className="input-row">
            <input
              id={`${id}-domain`}
              type="text"
              value={form.allowedDomain}
              readOnly={!editDomain}
              onChange={(e) => set('allowedDomain', e.target.value)}
              aria-invalid={errors.allowedDomain ? true : undefined}
              aria-describedby={`${id}-domain-help${errors.allowedDomain ? ` ${id}-domain-err` : ''}`}
            />
            {!editDomain ? (
              <button type="button" className="btn" onClick={() => setEditDomain(true)}>
                Cambiar
              </button>
            ) : null}
          </div>
          <p id={`${id}-domain-help`} className="muted small">
            Solo las cuentas de este dominio pueden unirse e invitarse.
          </p>
          {editDomain ? (
            <p className="banner warn">
              Cuidado: si cambias el dominio, las personas de otro dominio ya no podrán unirse ni ser invitadas. Quienes ya son
              colaboradores mantienen su acceso.
            </p>
          ) : null}
          {errors.allowedDomain ? (
            <p id={`${id}-domain-err`} className="field-error" role="alert">
              {errors.allowedDomain}
            </p>
          ) : null}
        </div>
      </fieldset>

      {status ? (
        <p className={`banner ${status.ok ? 'ok' : 'error'}`} role={status.ok ? 'status' : 'alert'}>
          {status.text}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Guardando…' : domainChanged ? 'Guardar y cambiar dominio' : 'Guardar cambios'}
        </button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const data = useData();
  const { uid } = useAdmin();
  const load = useLoad(() => data.getOrgConfig(), [data]);

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
            onSave={async (form) => {
              await data.saveOrgConfig(buildOrgConfig(form, uid, Date.now()));
              load.reload();
            }}
          />
        )}
      </section>
    </>
  );
}
