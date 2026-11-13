import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import {
  ACTIVE_BREAK_DURATION_OPTIONS,
  ACTIVE_BREAK_INTERVAL_OPTIONS,
  ACTIVE_BREAK_EXERCISES,
  ACTIVE_BREAK_PER_DAY_OPTIONS,
  EXERCISE_ZONES,
  DEFAULT_ACTIVE_BREAK_TIMES,
  MAX_ACTIVE_BREAK_TIMES,
  MAX_BREAK_VIDEOS,
  MAX_BREAK_VIDEO_TITLE,
  breakClosing,
  breakPlanSize,
  dailyBreakItem,
  exerciseArt,
  exerciseInstructions,
  newBreakVideoId,
  normalizeVideoTitle,
  normalizeVideoUrl,
  videoSite,
  videoThumbnail,
  type ActiveBreakExercise,
  type BreakItem,
  type BreakVideo,
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
import {
  activeBreaksForm,
  breakVideosForm,
  buildBreakVideosConfig,
  buildOrgConfig,
  orgConfigToForm,
  sameBreakVideos,
  validateBreakTimes,
  type ActiveBreaksForm,
  type BreakVideosForm,
} from '../lib/payloads';
import { SOURCE_LABEL, scheduleFor, type ScheduleContext } from '../lib/schedule';
import { useLoad } from '../lib/useLoad';

/** The options plus the saved value when it is not one of them (set outside the portal). */
function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

interface FormProps {
  form: ActiveBreaksForm;
  onChange(form: ActiveBreaksForm): void;
  /** The videos of the company (`config/breakVideos`), saved with the same button. */
  videos: BreakVideosForm;
  onVideosChange(videos: BreakVideosForm): void;
  /** Saves the fields. Throws on failure. */
  onSave(form: ActiveBreaksForm, videos: BreakVideosForm): Promise<void>;
}

/** "Pausa activa": the settings of `config/org` for the active breaks, and the videos. */
export function ActiveBreaksSettingsForm({ form, onChange, videos, onVideosChange, onSave }: FormProps) {
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
      await onSave(form, videos);
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
      <BreakVideosField
        videos={videos.videos}
        mode={videos.mode}
        disabled={!form.activeBreaksEnabled}
        onVideos={(v) => {
          onVideosChange({ ...videos, videos: v });
          setStatus(null);
        }}
        onMode={(m) => {
          onVideosChange({ ...videos, mode: m });
          setStatus(null);
        }}
      />
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

interface VideosProps {
  videos: readonly BreakVideo[];
  mode: ActiveBreakSettings['videoMode'];
  disabled: boolean;
  onVideos(videos: BreakVideo[]): void;
  onMode(mode: NonNullable<ActiveBreakSettings['videoMode']>): void;
}

/**
 * "Videos de la empresa" (spec 2026-11-13-videos-pausa-activa): links the
 * extension shows in the breaks, saved with the rest of the form.
 */
export function BreakVideosField({ videos, mode, disabled, onVideos, onMode }: VideosProps) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const full = videos.length >= MAX_BREAK_VIDEOS;

  const add = (): void => {
    const t = normalizeVideoTitle(title);
    const u = normalizeVideoUrl(url);
    if (!u) {
      setError('Pega el enlace completo del video, que empiece con https:// (YouTube, Vimeo, Google Drive, etc.).');
      return;
    }
    if (!t) {
      setError(`Ponle un nombre al video (hasta ${MAX_BREAK_VIDEO_TITLE} caracteres).`);
      return;
    }
    if (videos.some((v) => v.url === u)) {
      setError('Ese video ya está en la lista.');
      return;
    }
    onVideos([...videos, { id: newBreakVideoId(), title: t, url: u }]);
    setTitle('');
    setUrl('');
    setError(null);
  };

  const move = (i: number, d: -1 | 1): void => {
    const next = [...videos];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onVideos(next);
  };

  return (
    <div className="break-videos">
      <fieldset disabled={disabled}>
        <legend className="strong">Videos de la empresa</legend>
        <p className="muted small">
          Ancla tus propios videos de pausa activa (por ejemplo, de YouTube, Vimeo o Google Drive). La extensión los muestra
          en las pausas y cada persona lo abre en una pestaña nueva. Si el video es privado, todos deben tener acceso.
        </p>
        {videos.length > 0 ? (
          <>
            <ul className="break-video-list plain" aria-label="Videos anclados">
              {videos.map((v, i) => (
                <li key={v.id} className="break-video-item">
                  <VideoThumb url={v.url} />
                  <span className="break-video-text">
                    <span className="strong block">{v.title}</span>
                    <a className="small" href={v.url} target="_blank" rel="noreferrer noopener">
                      {videoSite(v.url)}
                    </a>
                  </span>
                  <span className="break-video-actions">
                    <button type="button" className="btn small-btn" aria-label={`Subir ${v.title}`} disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn small-btn"
                      aria-label={`Bajar ${v.title}`}
                      disabled={i === videos.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn small-btn"
                      aria-label={`Quitar ${v.title}`}
                      onClick={() => onVideos(videos.filter((x) => x.id !== v.id))}
                    >
                      Quitar
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="field">
              <label htmlFor={`${id}-video-mode`}>Cuándo mostrarlos</label>
              <select
                id={`${id}-video-mode`}
                value={mode ?? 'alternate'}
                onChange={(e) => onMode(e.target.value === 'always' ? 'always' : 'alternate')}
              >
                <option value="alternate">Intercalados: una pausa video, la siguiente un ejercicio</option>
                <option value="always">En todas las pausas, en lugar de los ejercicios</option>
              </select>
            </div>
          </>
        ) : null}
        {full ? (
          <p className="muted small">Llegaste al máximo de {MAX_BREAK_VIDEOS} videos. Quita uno para agregar otro.</p>
        ) : (
          <div className="break-video-add">
            <div className="field">
              <label htmlFor={`${id}-video-title`}>Nombre</label>
              <input
                id={`${id}-video-title`}
                type="text"
                value={title}
                maxLength={MAX_BREAK_VIDEO_TITLE}
                placeholder="Rutina de hombros con Camila"
                onChange={(e) => {
                  setTitle(e.target.value);
                  setError(null);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-video-url`}>Enlace</label>
              <input
                id={`${id}-video-url`}
                type="url"
                inputMode="url"
                value={url}
                placeholder="https://www.youtube.com/watch?v=…"
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
              />
            </div>
            <button type="button" className="btn" onClick={add}>
              Agregar video
            </button>
          </div>
        )}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {videos.length > 0 ? <p className="muted small">Los cambios se aplican al guardar.</p> : null}
      </fieldset>
    </div>
  );
}

/** Thumbnail of a video (YouTube) or a play tile. Decorative. */
export function VideoThumb({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : videoThumbnail(url);
  return (
    <span className={`video-thumb${src ? '' : ' empty'}`} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : null}
      <span className="video-play" />
    </span>
  );
}

/** Drawing + title + text of what a break suggests. */
function BreakItemRow({ item, heading, durationMinutes }: { item: BreakItem; heading: string; durationMinutes: number }) {
  if (item.kind === 'video') {
    return (
      <>
        <VideoThumb url={item.video.url} />
        <span>
          <span className="strong">
            {heading}: {item.video.title}
          </span>
          <span className="muted small block">
            Video de la empresa ·{' '}
            <a href={item.video.url} target="_blank" rel="noreferrer noopener">
              {videoSite(item.video.url)}
            </a>
          </span>
        </span>
      </>
    );
  }
  return (
    <>
      <ExerciseArt exercise={item.exercise} />
      <span>
        <span className="strong">
          {heading}: {item.exercise.title}
        </span>
        <span className="muted small block">{exerciseInstructions(item.exercise, durationMinutes)}</span>
      </span>
    </>
  );
}

const itemTitle = (item: BreakItem | undefined): string =>
  !item ? '' : item.kind === 'video' ? `Video: ${item.video.title}` : item.exercise.title;

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
  const plan = Array.from({ length: size }, (_, i) => dailyBreakItem(settings, date, i));
  return (
    <>
      <ol className="break-plan plain" aria-label="Plan del día">
        {plan.map((item, i) => (
          <li key={i} className="break-plan-item">
            <BreakItemRow
              item={item}
              heading={`Pausa ${i + 1}${fixed ? ` · ${settings.times[i]}` : ''}`}
              durationMinutes={settings.durationMinutes}
            />
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
                          {formatTime(t.at)} · {itemTitle(plan[t.index])}
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
  videos: BreakVideosForm;
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
    const [config, videosDoc, users, general, persons] = await Promise.all([
      data.getOrgConfig(),
      // Unreadable (rules before the videos): none.
      data.getBreakVideos().catch(() => null),
      data.listUsers(),
      data.getScheduleConfig(),
      data.listPersonSchedules(),
    ]);
    return { config, videos: breakVideosForm(videosDoc), users, general, persons };
  }, [data]);
  const [form, setForm] = useState<ActiveBreaksForm>(() => activeBreaksForm(null));
  const config = load.data?.config;
  useEffect(() => setForm(activeBreaksForm(config ?? null)), [config]);
  const [videos, setVideos] = useState<BreakVideosForm>(() => breakVideosForm(null));
  const savedVideos = load.data?.videos;
  useEffect(() => {
    if (savedVideos) setVideos(savedVideos);
  }, [savedVideos]);

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
              videos={videos}
              onVideosChange={setVideos}
              onSave={async (fields, nextVideos) => {
                // The rest of config/org as saved: this page only changes the active breaks.
                const full = { ...orgConfigToForm(load.data?.config ?? null, ALLOWED_DOMAINS), ...fields };
                await data.saveOrgConfig(buildOrgConfig(full, uid, Date.now(), profile.email));
                if (!load.data || !sameBreakVideos(nextVideos, load.data.videos)) {
                  await data.saveBreakVideos(buildBreakVideosConfig(nextVideos, uid, Date.now()));
                }
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
            <BreakTimesTable settings={settingsOfForm(form, videos)} users={load.data.users} schedules={schedules} date={date} />
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
