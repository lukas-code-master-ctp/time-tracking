import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MAX_ALLOWED_DOMAINS, allowedDomainsOr, emailDomain, type OrgConfig } from '@timetracking/shared';
import { ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { ALLOWED_DOMAINS } from '../env';
import { formatRelativeDateTime } from '../lib/dates';
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
    </>
  );
}
