import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  MAX_HOLIDAYS,
  MAX_TOLERANCE_MINUTES,
  WEEKDAYS,
  WEEKDAY_NAMES,
  type PersonSchedule,
  type ScheduleConfig,
  type ScheduleIssue,
  type Weekday,
} from '@timetracking/shared';
import { ConfirmDialog } from './Modal';
import {
  DEFAULT_WEEK,
  addChileHolidays,
  addHoliday,
  copyMondayToWeekdays,
  dayMessages,
  describeWeek,
  holidayLabel,
  messagesOf,
  removeHoliday,
  removePastHolidays,
  validateScheduleForm,
  validateWeekForm,
  weekToForm,
  type DayForm,
  type ScheduleForm,
  type WeekForm,
} from '../lib/schedule';
import { errorMessage } from '../lib/messages';

// ---------- week ----------

interface WeekProps {
  week: WeekForm;
  onChange(week: WeekForm): void;
  /** Problems of the week (shared validation), shown under each day. */
  issues: readonly ScheduleIssue[];
}

/** Editor of the 7 days (general schedule and per-person exception). */
export function WeekEditor({ week, onChange, issues }: WeekProps) {
  const id = useId();
  const setDay = (wd: Weekday, patch: Partial<DayForm>): void => onChange({ ...week, [wd]: { ...week[wd], ...patch } });
  return (
    <div className="week-editor">
      <div className="week-tools">
        <button type="button" className="btn small-btn" onClick={() => onChange(copyMondayToWeekdays(week))}>
          Copiar lunes a martes–viernes
        </button>
      </div>
      <ul className="week-days" aria-label="Horario por día">
        {WEEKDAYS.map((wd) => {
          const d = week[wd];
          const name = WEEKDAY_NAMES[wd];
          const msgs = dayMessages(issues, wd);
          const errId = `${id}-${wd}-err`;
          const invalid = msgs.length > 0 ? true : undefined;
          const described = msgs.length > 0 ? errId : undefined;
          return (
            <li key={wd} className={`week-day${d.enabled ? '' : ' off'}`} data-testid={`day-${wd}`}>
              <label className="week-day-name">
                <input type="checkbox" checked={d.enabled} onChange={(e) => setDay(wd, { enabled: e.target.checked })} />
                <span>
                  {name}
                  <span className="sr-only">: día laboral</span>
                </span>
              </label>
              {d.enabled ? (
                <div className="week-day-fields">
                  <div className="time-pair">
                    <label>
                      Entrada<span className="sr-only"> ({name})</span>
                      <input
                        type="time"
                        value={d.start}
                        onChange={(e) => setDay(wd, { start: e.target.value })}
                        aria-invalid={invalid}
                        aria-describedby={described}
                      />
                    </label>
                    <label>
                      Salida<span className="sr-only"> ({name})</span>
                      <input
                        type="time"
                        value={d.end}
                        onChange={(e) => setDay(wd, { end: e.target.value })}
                        aria-invalid={invalid}
                        aria-describedby={described}
                      />
                    </label>
                  </div>
                  <label className="lunch-toggle">
                    <input type="checkbox" checked={d.lunch} onChange={(e) => setDay(wd, { lunch: e.target.checked })} />
                    <span>
                      Colación<span className="sr-only"> ({name})</span>
                    </span>
                  </label>
                  {d.lunch ? (
                    <div className="time-pair">
                      <label>
                        Desde<span className="sr-only"> (colación del {name.toLowerCase()})</span>
                        <input
                          type="time"
                          value={d.lunchStart}
                          onChange={(e) => setDay(wd, { lunchStart: e.target.value })}
                          aria-invalid={invalid}
                          aria-describedby={described}
                        />
                      </label>
                      <label>
                        Hasta<span className="sr-only"> (colación del {name.toLowerCase()})</span>
                        <input
                          type="time"
                          value={d.lunchEnd}
                          onChange={(e) => setDay(wd, { lunchEnd: e.target.value })}
                          aria-invalid={invalid}
                          aria-describedby={described}
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              ) : (
                <span className="chip muted-chip week-day-free">Libre</span>
              )}
              {msgs.length > 0 ? (
                <div id={errId} className="field-error week-day-error" role="alert">
                  {msgs.map((m) => (
                    <p key={m}>{m}</p>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- holidays ----------

interface HolidayProps {
  holidays: readonly string[];
  onChange(holidays: string[]): void;
  /** `YYYY-MM-DD` of today (Chile): older dates are marked as past. */
  today: string;
  errors: readonly string[];
}

export function HolidayEditor({ holidays, onChange, today, errors }: HolidayProps) {
  const id = useId();
  const [date, setDate] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const add = (): void => {
    const res = addHoliday(holidays, date);
    if (!res.ok) {
      setAddError(res.error);
      return;
    }
    onChange(res.holidays);
    setDate('');
    setAddError(null);
    setNotice(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  };
  const addChile = (): void => {
    const res = addChileHolidays(holidays);
    onChange(res.holidays);
    setNotice(
      res.added === 0
        ? 'Ya están todos los feriados de Chile 2026–2027.'
        : `Se ${res.added === 1 ? 'agregó 1 feriado' : `agregaron ${res.added} feriados`} de Chile 2026–2027.`,
    );
  };
  const past = holidays.filter((d) => d < today).length;
  const removePast = (): void => {
    const res = removePastHolidays(holidays, today);
    onChange(res.holidays);
    setNotice(`Se ${res.removed === 1 ? 'quitó 1 feriado pasado' : `quitaron ${res.removed} feriados pasados`}.`);
  };

  return (
    <fieldset className="holidays" aria-describedby={`${id}-help${errors.length > 0 ? ` ${id}-err` : ''}`}>
      <legend>Feriados</legend>
      <p id={`${id}-help`} className="muted small">
        Son días libres para todo el equipo (también para quienes tienen horario personalizado). Máximo {MAX_HOLIDAYS};
        hay {holidays.length}.
      </p>
      <div className="row-actions">
        <button type="button" className="btn small-btn" onClick={addChile}>
          Agregar feriados de Chile 2026–2027
        </button>
        {past > 0 ? (
          <button type="button" className="btn small-btn" onClick={removePast}>
            Quitar feriados pasados ({past})
          </button>
        ) : null}
      </div>
      {notice ? (
        <p className="muted small" role="status">
          {notice}
        </p>
      ) : null}
      {holidays.length === 0 ? (
        <p className="muted small">No hay feriados. Todos los días siguen el horario semanal.</p>
      ) : (
        <ul className="holiday-list" aria-label="Feriados">
          {holidays.map((d) => {
            const h = holidayLabel(d);
            return (
              <li key={d} className={`holiday-item${d < today ? ' past' : ''}`}>
                <span className="holiday-text">
                  <span className="holiday-date">{h.label}</span>
                  <span className="muted small" title={h.name ?? undefined}>
                    {h.name ?? 'Feriado agregado'}
                    {d < today ? ' · pasado' : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn small-btn"
                  onClick={() => {
                    onChange(removeHoliday(holidays, d));
                    setNotice(null);
                  }}
                  aria-label={`Quitar feriado ${h.label}${h.name ? ` (${h.name})` : ''}`}
                >
                  Quitar
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="field">
        <label htmlFor={`${id}-add`}>Agregar feriado</label>
        <div className="input-row">
          <input
            id={`${id}-add`}
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setAddError(null);
            }}
            onKeyDown={onKey}
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? `${id}-add-err` : undefined}
          />
          <button type="button" className="btn" onClick={add}>
            Agregar fecha
          </button>
        </div>
        {addError ? (
          <p id={`${id}-add-err`} className="field-error" role="alert">
            {addError}
          </p>
        ) : null}
      </div>
      {errors.length > 0 ? (
        <div id={`${id}-err`} className="field-error" role="alert">
          {errors.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

// ---------- general schedule ----------

interface FormProps {
  initial: ScheduleForm;
  /** A new schedule (not saved yet): the button says so. */
  isNew: boolean;
  today: string;
  /** Builds and saves the document. Throws on failure. */
  onSave(form: ScheduleForm): Promise<void>;
  onCancel?(): void;
  /** Shown only for a saved schedule. */
  onDelete?(): void;
}

/** "Configuración → Horario": week, tolerance, reminders and holidays, validated live. */
export function ScheduleConfigForm({ initial, isNew, today, onSave, onCancel, onDelete }: FormProps) {
  const id = useId();
  const [form, setForm] = useState<ScheduleForm>(initial);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const issues = useMemo(() => validateScheduleForm(form), [form]);
  const toleranceErrors = messagesOf(issues, 'toleranceMinutes');

  const update = (patch: Partial<ScheduleForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setStatus(null);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (issues.length > 0) {
      setStatus({ ok: false, text: 'Corrige los problemas marcados antes de guardar.' });
      return;
    }
    setBusy(true);
    try {
      await onSave(form);
      setStatus({ ok: true, text: 'Horario guardado. La extensión lo aplica en unos minutos.' });
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form schedule-form" onSubmit={(e) => void submit(e)} noValidate aria-label="Horario general">
      {isNew ? (
        <p className="banner warn">
          Estos son valores sugeridos: revísalos y guarda para activar el horario. Hasta que lo guardes, nada cambia.
        </p>
      ) : null}
      <fieldset>
        <legend>Semana</legend>
        <p className="muted small">
          Horario de entrada y salida de cada día, en hora de Chile. La colación es opcional y no cuenta como tiempo de
          trabajo. Fuera del horario y en la colación la extensión no mide actividad.
        </p>
        <WeekEditor week={form.week} onChange={(week) => update({ week })} issues={issues} />
      </fieldset>

      <fieldset>
        <legend>Tolerancia y recordatorios</legend>
        <div className="field">
          <label htmlFor={`${id}-tol`}>Tolerancia (minutos)</label>
          <input
            id={`${id}-tol`}
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_TOLERANCE_MINUTES}
            step={1}
            value={form.toleranceMinutes}
            onChange={(e) => update({ toleranceMinutes: e.target.value })}
            aria-invalid={toleranceErrors.length > 0 ? true : undefined}
            aria-describedby={`${id}-tol-help${toleranceErrors.length > 0 ? ` ${id}-tol-err` : ''}`}
          />
          <p id={`${id}-tol-help`} className="muted small">
            Margen antes de contar un atraso o una salida anticipada (0 a {MAX_TOLERANCE_MINUTES}).
          </p>
          {toleranceErrors.length > 0 ? (
            <p id={`${id}-tol-err`} className="field-error" role="alert">
              {toleranceErrors.join(' ')}
            </p>
          ) : null}
        </div>
        <label className="switch-row" htmlFor={`${id}-rem`}>
          <input
            id={`${id}-rem`}
            type="checkbox"
            checked={form.remindersEnabled}
            onChange={(e) => update({ remindersEnabled: e.target.checked })}
          />
          <span>
            <span className="strong">Recordatorios</span>
            <span className="muted small block">
              La extensión avisa al comienzo del horario si la jornada no está iniciada, y al final si sigue abierta.
            </span>
          </span>
        </label>
      </fieldset>

      <HolidayEditor holidays={form.holidays} onChange={(holidays) => update({ holidays })} today={today} errors={messagesOf(issues, 'holidays')} />

      {status ? (
        <p className={`banner ${status.ok ? 'ok' : 'error'}`} role={status.ok ? 'status' : 'alert'}>
          {status.text}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Guardando…' : isNew ? 'Guardar y activar horario' : 'Guardar horario'}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
        ) : null}
        {onDelete ? (
          <button type="button" className="btn danger-outline push-end" onClick={onDelete} disabled={busy}>
            Eliminar horario
          </button>
        ) : null}
      </div>
    </form>
  );
}


// ---------- per-person exception ----------

interface PersonProps {
  /** Display name of the person. */
  name: string;
  /** General schedule (null = the organization has none). */
  general: ScheduleConfig | null;
  /** Current exception (null = uses the general one). */
  current: PersonSchedule | null;
  /** Saves `schedules/{uid}`. Throws on failure. */
  onSave(week: WeekForm): Promise<void>;
  /** Deletes `schedules/{uid}` ("Volver al general"). Throws on failure. */
  onReset(): Promise<void>;
}

/** "Horario: General / Personalizado" of one collaborator (Colaboradores). */
export function PersonScheduleEditor({ name, general, current, onSave, onReset }: PersonProps) {
  const [week, setWeek] = useState<WeekForm | null>(() => (current ? weekToForm(current.week) : null));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const issues = useMemo(() => (week ? validateWeekForm(week) : []), [week]);

  const save = async (): Promise<void> => {
    if (!week) return;
    if (issues.length > 0) {
      setStatus({ ok: false, text: 'Corrige los problemas marcados antes de guardar.' });
      return;
    }
    setBusy(true);
    try {
      await onSave(week);
      setStatus({ ok: true, text: `Horario personalizado de ${name} guardado.` });
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    setResetError(null);
    try {
      await onReset();
      setConfirmReset(false);
      setWeek(null);
      setStatus({ ok: true, text: general ? `${name} vuelve a usar el horario general.` : `${name} queda sin horario.` });
    } catch (err) {
      setResetError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="person-schedule">
      {!general && (week || current) ? (
        <p className="banner warn">
          La organización no tiene horario general. {name} tendrá solo este horario, sin feriados ni recordatorios (dependen
          del horario general, en Configuración).
        </p>
      ) : null}
      {week ? (
        <>
          <p className="muted small">
            {current ? 'Horario personalizado: reemplaza la semana del horario general.' : 'Nuevo horario personalizado (aún no se guarda).'}{' '}
            Los feriados y la tolerancia son siempre los generales.
          </p>
          <WeekEditor week={week} onChange={(w) => {
            setWeek(w);
            setStatus(null);
          }} issues={issues} />
        </>
      ) : general ? (
        <div className="small">
          <p className="muted">Usa el horario general:</p>
          <ul className="week-summary">
            {describeWeek(general.week).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted small">
          Sin horario: no hay horario general. Puedes darle un horario personalizado o configurar el general en Configuración.
        </p>
      )}
      {status ? (
        <p className={`banner ${status.ok ? 'ok' : 'error'}`} role={status.ok ? 'status' : 'alert'}>
          {status.text}
        </p>
      ) : null}
      <div className="form-actions">
        {week ? (
          <>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar horario personalizado'}
            </button>
            {current ? (
              <button
                type="button"
                className="btn danger-outline"
                onClick={() => {
                  setResetError(null);
                  setConfirmReset(true);
                }}
                disabled={busy}
              >
                Volver al general
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => setWeek(null)} disabled={busy}>
                Cancelar
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setStatus(null);
              setWeek(weekToForm(general?.week ?? DEFAULT_WEEK));
            }}
          >
            Personalizar horario
          </button>
        )}
      </div>
      {confirmReset ? (
        <ConfirmDialog
          title="Volver al horario general"
          message={
            <p>
              {general
                ? `Se borra el horario personalizado de ${name} y vuelve a usar el horario general.`
                : `Se borra el horario personalizado de ${name}. Como no hay horario general, quedará sin horario.`}
            </p>
          }
          confirmLabel="Volver al general"
          danger
          busy={busy}
          error={resetError}
          onConfirm={() => void reset()}
          onCancel={() => setConfirmReset(false)}
        />
      ) : null}
    </div>
  );
}
