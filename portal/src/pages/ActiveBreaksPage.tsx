import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import {
  ACTIVE_BREAK_DURATION_OPTIONS,
  ACTIVE_BREAK_INTERVAL_OPTIONS,
  ACTIVE_BREAK_EXERCISES,
  ACTIVE_BREAK_PER_DAY_OPTIONS,
  EXERCISE_ZONES,
  DEFAULT_ACTIVE_BREAK_TIMES,
  MAX_ACTIVE_BREAK_TIMES,
  breakClosing,
  breakPlanSize,
  dailyExercise,
  exerciseArt,
  exerciseInstructions,
  type ActiveBreakExercise,
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
import { plannedBreakSlots, settingsOfForm } from '../lib/breaks';
import { formatLongDate, formatRelativeDateTime, formatTime, isValidDate, zonedDate } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { activeBreaksForm, buildOrgConfig, orgConfigToForm, validateBreakTimes, type ActiveBreaksForm } from '../lib/payloads';
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

  const timesError = validateBreakTimes(form);
  const setTime = (i: number, value: string): void =>
    set(
      'activeBreakTimes',
      form.activeBreakTimes.map((t, j) => (j === i ? value : t)),
    );
  const addTime = (): void => {
    const last = form.activeBreakTimes.filter((t) => t !== '').sort().at(-1);
    // One hour after the last one (or the first default), capped at 23:00.
    const next = last ? `${String(Math.min(23, Number(last.slice(0, 2)) + 1)).padStart(2, '0')}:${last.slice(3)}` : DEFAULT_ACTIVE_BREAK_TIMES[0]!;
    set('activeBreakTimes', [...form.activeBreakTimes, next]);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (timesError) {
      setStatus({ ok: false, text: timesError });
      return;
    }
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
              trabajo continuo, un número de veces al día repartidas en su horario o a las horas que elijas (nunca
              durante reuniones ni la colación). Si se alejó del computador lo que dura la pausa, ya cuenta como pausa. Cada persona puede
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
              onChange={(e) =>
                set('activeBreakMode', e.target.value === 'daily' ? 'daily' : e.target.value === 'times' ? 'times' : 'interval')
              }
            >
              <option value="interval">Según el trabajo continuo</option>
              <option value="daily">Veces al día</option>
              <option value="times">A horas fijas</option>
            </select>
          </div>
          {form.activeBreakMode === 'times' ? null : form.activeBreakMode === 'daily' ? (
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
        {form.activeBreakMode === 'times' ? (
          <div className="field">
            <span className="field-label" id={`${id}-breaks-times`}>
              Horas de la pausa
            </span>
            <ul className="break-time-inputs plain" aria-labelledby={`${id}-breaks-times`}>
              {form.activeBreakTimes.map((t, i) => (
                <li key={i}>
                  <input
                    type="time"
                    aria-label={`Hora de la pausa ${i + 1}`}
                    value={t}
                    step={300}
                    disabled={!form.activeBreaksEnabled}
                    aria-invalid={timesError ? true : undefined}
                    onChange={(e) => setTime(i, e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn small-btn"
                    aria-label={`Quitar la pausa ${i + 1}`}
                    disabled={!form.activeBreaksEnabled || form.activeBreakTimes.length <= 1}
                    onClick={() => set('activeBreakTimes', form.activeBreakTimes.filter((_, j) => j !== i))}
                  >
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn small-btn"
              disabled={!form.activeBreaksEnabled || form.activeBreakTimes.length >= MAX_ACTIVE_BREAK_TIMES}
              onClick={addTime}
            >
              Agregar hora
            </button>
            {timesError && form.activeBreaksEnabled ? (
              <p className="field-error" role="alert">
                {timesError}
              </p>
            ) : null}
            <p className="muted small">
              Las mismas horas para todo el equipo. A quien a esa hora está en colación, fuera de su horario o sin la
              jornada iniciada no le llega el aviso de esa pausa.
            </p>
          </div>
        ) : null}
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

/** When each active collaborator gets the reminders on `date` (`daily` and `times` modes). */
export function BreakTimesTable({ settings, users, schedules, date }: TimesProps) {
  if (!settings.enabled) {
    return <p className="muted">La pausa activa está apagada: nadie recibe recordatorios.</p>;
  }
  if (settings.mode === 'interval') {
    return (
      <p className="muted">
        Con la frecuencia "Según el trabajo continuo" no hay horas fijas: cada persona recibe el aviso después de{' '}
        {settings.intervalMinutes} min trabajando sin una pausa, así que depende de cómo trabaja ese día. Elige "Veces al
        día" o "A horas fijas" para ver aquí a qué hora le toca a cada uno.
      </p>
    );
  }
  const fixed = settings.mode === 'times';
  const active = users
    .filter((u) => u.status === 'active')
    .sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email, 'es'));
  if (active.length === 0) return <Empty title="Aún no hay colaboradores activos" />;
  const size = breakPlanSize(settings);
  const plan = Array.from({ length: size }, (_, i) => dailyExercise(date, i, size));
  return (
    <>
      <ol className="break-plan plain" aria-label="Plan del día">
        {plan.map((ex, i) => (
          <li key={i} className="break-plan-item">
            <ExerciseArt exercise={ex} />
            <span>
              <span className="strong">
                Pausa {i + 1}
                {fixed ? ` · ${settings.times[i]}` : ''}: {ex.title}
              </span>
              <span className="muted small block">{exerciseInstructions(ex, settings.durationMinutes)}</span>
            </span>
          </li>
        ))}
      </ol>
      <ul className="list" aria-label="Pausas previstas por colaborador">
        {active.map((u) => {
          const eff = scheduleFor(schedules, u.id);
          const slots = plannedBreakSlots(settings, eff, date, null) ?? [];
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
                {!eff.week && !fixed
                  ? 'Sin horario: se reparten en 9 horas desde que inicia la jornada'
                  : slots.length === 0
                    ? fixed
                      ? 'Ninguna de las horas cae en su horario este día'
                      : 'No trabaja este día'
                    : slots.map((t) => (
                        <span key={t.at} className="block">
                          {formatTime(t.at)} · {plan[t.index]?.title}
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

/**
 * The animation of an exercise (our own SVG from packages/shared, no text
 * from users). Decorative: the title is always next to it.
 */
export function ExerciseArt({ exercise }: { exercise: ActiveBreakExercise }) {
  const html = useMemo(() => exerciseArt(exercise, { label: '' }), [exercise]);
  return <span className="exercise-art-box" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />;
}

const POSTURE_LABEL: Record<ActiveBreakExercise['posture'], string> = {
  sentado: 'Sentado',
  'de pie': 'De pie',
  'sentado o de pie': 'Sentado o de pie',
  'sentado y de pie': 'Sentado y de pie',
};

/** The library of exercises the extension suggests, by zone. */
export function ExerciseCatalog({ mode, durationMinutes }: { mode: ActiveBreakSettings['mode']; durationMinutes: number }) {
  const closing = breakClosing(durationMinutes);
  return (
    <>
      <p className="muted small">
        {ACTIVE_BREAK_EXERCISES.length} ejercicios en {EXERCISE_ZONES.length} zonas. Se recorren todos, en un orden
        distinto cada vuelta, antes de repetir uno, y nunca tocan dos de la misma zona seguidos.{' '}
        {mode === 'interval'
          ? 'Con "Según el trabajo continuo" cada persona avanza a su propio ritmo.'
          : 'Con "Veces al día" y "A horas fijas" todos hacen el mismo ejercicio en cada pausa.'}
        {closing ? ` Con pausas de ${durationMinutes} min, cada ejercicio termina con: "${closing}"` : ''}
      </p>
      <div className="exercise-zones" role="region" aria-label="Biblioteca de ejercicios">
        {EXERCISE_ZONES.map((zone) => (
          <section key={zone.id} className="exercise-zone" aria-labelledby={`zone-${zone.id}`}>
            <h3 id={`zone-${zone.id}`}>{zone.label}</h3>
            <ul className="exercise-grid plain">
              {ACTIVE_BREAK_EXERCISES.filter((ex) => ex.zone === zone.id).map((ex) => (
                <li key={ex.id} className="exercise-item">
                  <ExerciseArt exercise={ex} />
                  <span>
                    <span className="strong block">{ex.title}</span>
                    <span className="muted small block">{ex.text}</span>
                    <span className="tag small">{POSTURE_LABEL[ex.posture]}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
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
