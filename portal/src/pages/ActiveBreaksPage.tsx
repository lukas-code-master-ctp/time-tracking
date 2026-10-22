import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  ACTIVE_BREAK_DURATION_OPTIONS,
  ACTIVE_BREAK_INTERVAL_OPTIONS,
  ACTIVE_BREAK_EXERCISES,
  ACTIVE_BREAK_PER_DAY_OPTIONS,
  breakClosing,
  dailyExercise,
  exerciseInstructions,
  type ActiveBreakSettings,
  type OrgConfig,
  type PersonSchedule,
  type ScheduleConfig,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { initials } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { ALLOWED_DOMAINS } from '../env';
import { plannedBreaks, settingsOfForm } from '../lib/breaks';
import { formatLongDate, formatRelativeDateTime, formatTime, isValidDate, zonedDate } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { activeBreaksForm, buildOrgConfig, orgConfigToForm, type ActiveBreaksForm } from '../lib/payloads';
import { SOURCE_LABEL, scheduleFor, type ScheduleContext } from '../lib/schedule';
import { useLoad } from '../lib/useLoad';

/** The options plus the saved value when it is not one of them (set outside the portal). */
function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

interface FormProps {
  form: ActiveBreaksForm;
  onChange(form: ActiveBreaksForm): void;
  /** Saves the fields. Throws on failure. */
  onSave(form: ActiveBreaksForm): Promise<void>;
}

/** "Pausa activa": the settings of `config/org` for the active breaks. */
export function ActiveBreaksSettingsForm({ form, onChange, onSave }: FormProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const set = <K extends keyof ActiveBreaksForm>(key: K, value: ActiveBreaksForm[K]): void => {
    onChange({ ...form, [key]: value });
    setStatus(null);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(form);
      setStatus({ ok: true, text: 'Configuración guardada. La extensión la aplica en unos minutos.' });
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)} noValidate>
      <fieldset>
        <legend className="sr-only">Pausa activa</legend>
        <label className="switch-row" htmlFor={`${id}-breaks`}>
          <input
            id={`${id}-breaks`}
            type="checkbox"
            checked={form.activeBreaksEnabled}
            onChange={(e) => set('activeBreaksEnabled', e.target.checked)}
          />
          <span>
            <span className="strong">Recordar pausas activas</span>
            <span className="muted small block">
              La extensión avisa a cada persona que tome una pausa breve con un ejercicio sugerido, después de un rato de
              trabajo continuo o un número de veces al día repartidas en su horario (nunca durante reuniones ni la
              colación). Si se alejó del computador lo que dura la pausa, ya cuenta como pausa. Cada persona puede
              desactivarlo en su extensión. Las pausas que marca como tomadas se ven en su línea de tiempo.
            </span>
          </span>
        </label>
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${id}-breaks-mode`}>Frecuencia</label>
            <select
              id={`${id}-breaks-mode`}
              value={form.activeBreakMode}
              disabled={!form.activeBreaksEnabled}
              onChange={(e) => set('activeBreakMode', e.target.value === 'daily' ? 'daily' : 'interval')}
            >
              <option value="interval">Según el trabajo continuo</option>
              <option value="daily">Veces al día</option>
            </select>
          </div>
          {form.activeBreakMode === 'daily' ? (
            <div className="field">
              <label htmlFor={`${id}-breaks-per-day`}>Veces al día</label>
              <select
                id={`${id}-breaks-per-day`}
                value={form.activeBreaksPerDay}
                disabled={!form.activeBreaksEnabled}
                onChange={(e) => set('activeBreaksPerDay', Number(e.target.value))}
              >
                {withCurrent(ACTIVE_BREAK_PER_DAY_OPTIONS, form.activeBreaksPerDay).map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? 'vez' : 'veces'} al día
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="field">
              <label htmlFor={`${id}-breaks-every`}>Cada cuánto</label>
              <select
                id={`${id}-breaks-every`}
                value={form.activeBreakIntervalMinutes}
                disabled={!form.activeBreaksEnabled}
                onChange={(e) => set('activeBreakIntervalMinutes', Number(e.target.value))}
              >
                {withCurrent(ACTIVE_BREAK_INTERVAL_OPTIONS, form.activeBreakIntervalMinutes).map((m) => (
                  <option key={m} value={m}>
                    {m} min de trabajo continuo
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor={`${id}-breaks-len`}>Duración de la pausa</label>
            <select
              id={`${id}-breaks-len`}
              value={form.activeBreakMinutes}
              disabled={!form.activeBreaksEnabled}
              onChange={(e) => set('activeBreakMinutes', Number(e.target.value))}
            >
              {withCurrent(ACTIVE_BREAK_DURATION_OPTIONS, form.activeBreakMinutes).map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </div>
        </div>
        {form.activeBreakMode === 'daily' ? (
          <p className="muted small">
            Se reparten en partes iguales dentro del horario de cada persona, sin contar la colación. Sin horario, se
            reparten en 9 horas desde que inicia la jornada. Abajo ves a qué hora le toca a cada uno.
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
          {busy ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>
    </form>
  );
}

interface TimesProps {
  settings: ActiveBreakSettings;
  users: readonly WithId<UserProfile>[];
  schedules: ScheduleContext;
  date: string;
}

/** When each active collaborator gets the reminders on `date` (daily mode). */
export function BreakTimesTable({ settings, users, schedules, date }: TimesProps) {
  if (!settings.enabled) {
    return <p className="muted">La pausa activa está apagada: nadie recibe recordatorios.</p>;
  }
  if (settings.mode !== 'daily') {
    return (
      <p className="muted">
        Con la frecuencia "Según el trabajo continuo" no hay horas fijas: cada persona recibe el aviso después de{' '}
        {settings.intervalMinutes} min trabajando sin una pausa, así que depende de cómo trabaja ese día. Elige "Veces al
        día" para ver aquí a qué hora le toca a cada uno.
      </p>
    );
  }
  const active = users
    .filter((u) => u.status === 'active')
    .sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email, 'es'));
  if (active.length === 0) return <Empty title="Aún no hay colaboradores activos" />;
  const plan = Array.from({ length: settings.perDay }, (_, i) => dailyExercise(date, i, settings.perDay));
  return (
    <>
      <ol className="break-plan plain" aria-label="Plan del día">
        {plan.map((ex, i) => (
          <li key={i}>
            <span className="strong">
              Pausa {i + 1}: {ex.title}
            </span>
            <span className="muted small block">{exerciseInstructions(ex, settings.durationMinutes)}</span>
          </li>
        ))}
      </ol>
      <ul className="list" aria-label="Pausas previstas por colaborador">
        {active.map((u) => {
          const eff = scheduleFor(schedules, u.id);
          const times = plannedBreaks(settings, eff, date, null) ?? [];
          return (
            <li key={u.id} className="list-item">
              <div className="person">
                <span className="avatar" aria-hidden="true">
                  {initials(u.displayName || u.email)}
                </span>
                <span className="person-text">
                  <span className="person-name">{u.displayName || u.email}</span>
                  <span className="person-email">Horario: {SOURCE_LABEL[eff.source].toLowerCase()}</span>
                </span>
              </div>
              <span className="break-times">
                {!eff.week
                  ? 'Sin horario: se reparten en 9 horas desde que inicia la jornada'
                  : times.length === 0
                    ? 'No trabaja este día'
                    : times.map((t, i) => (
                        <span key={t} className="block">
                          {formatTime(t)} · {plan[i]?.title}
                        </span>
                      ))}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The exercises the extension suggests, in the order they rotate. */
export function ExerciseCatalog({ mode, durationMinutes }: { mode: ActiveBreakSettings['mode']; durationMinutes: number }) {
  const closing = breakClosing(durationMinutes);
  return (
    <>
      <p className="muted small">
        {mode === 'daily'
          ? 'Con "Veces al día" todos hacen el mismo ejercicio en cada pausa: el plan avanza en este orden de una pausa a la siguiente y de un día al otro.'
          : 'Con "Según el trabajo continuo" cada persona recorre estos ejercicios en orden, a su propio ritmo.'}
        {closing ? ` Con pausas de ${durationMinutes} min, cada ejercicio termina con: "${closing}"` : ''}
      </p>
      <ol className="break-plan" aria-label="Ejercicios">
        {ACTIVE_BREAK_EXERCISES.map((ex) => (
          <li key={ex.id}>
            <span className="strong">{ex.title}</span>
            <span className="muted small block">{ex.text}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

interface Loaded {
  config: OrgConfig | null;
  users: WithId<UserProfile>[];
  general: ScheduleConfig | null;
  persons: WithId<PersonSchedule>[];
}

export function ActiveBreaksPage() {
  const data = useData();
  const { uid, profile } = useAdmin();
  const today = zonedDate(Date.now());
  const [date, setDate] = useState(today);
  const load = useLoad<Loaded>(async () => {
    const [config, users, general, persons] = await Promise.all([
      data.getOrgConfig(),
      data.listUsers(),
      data.getScheduleConfig(),
      data.listPersonSchedules(),
    ]);
    return { config, users, general, persons };
  }, [data]);
  const [form, setForm] = useState<ActiveBreaksForm>(() => activeBreaksForm(null));
  const config = load.data?.config;
  useEffect(() => setForm(activeBreaksForm(config ?? null)), [config]);

  const schedules: ScheduleContext | null = load.data
    ? { config: load.data.general, persons: new Map(load.data.persons.map(({ id, ...p }) => [id, p])) }
    : null;

  return (
    <>
      <PageHeader
        title="Pausa activa"
        subtitle={
          config
            ? `Última modificación ${formatRelativeDateTime(config.updatedAt, Date.now())}${config.updatedBy === uid ? ' (por ti)' : ''}`
            : 'Recordatorios para tomar una pausa breve con un ejercicio'
        }
      />
      {load.error && load.data === undefined ? (
        <section className="card">
          <ErrorState error={load.error} onRetry={load.reload} />
        </section>
      ) : load.data === undefined || !schedules ? (
        <section className="card">
          <Loading />
        </section>
      ) : (
        <>
          <section className="card">
            <ActiveBreaksSettingsForm
              form={form}
              onChange={setForm}
              onSave={async (fields) => {
                // The rest of config/org as saved: this page only changes the active breaks.
                const full = { ...orgConfigToForm(load.data?.config ?? null, ALLOWED_DOMAINS), ...fields };
                await data.saveOrgConfig(buildOrgConfig(full, uid, Date.now(), profile.email));
                load.reload();
              }}
            />
          </section>
          <section className="card" aria-labelledby="h-break-times">
            <div className="card-head">
              <h2 id="h-break-times">Plan de pausas</h2>
              <div className="day-picker">
                <label className="sr-only" htmlFor="break-day">
                  Día
                </label>
                <input
                  id="break-day"
                  type="date"
                  value={date}
                  onChange={(e) => {
                    if (isValidDate(e.target.value)) setDate(e.target.value);
                  }}
                />
              </div>
            </div>
            <p className="muted small">
              {formatLongDate(date)}. Son horas aproximadas: si la persona está en una reunión o fuera del computador, el
              aviso se corre; y quien desactivó los recordatorios en su extensión no los recibe.
            </p>
            <BreakTimesTable settings={settingsOfForm(form)} users={load.data.users} schedules={schedules} date={date} />
          </section>
          <section className="card" aria-labelledby="h-exercises">
            <h2 id="h-exercises">Ejercicios</h2>
            <ExerciseCatalog mode={form.activeBreakMode} durationMinutes={form.activeBreakMinutes} />
          </section>
        </>
      )}
    </>
  );
}
