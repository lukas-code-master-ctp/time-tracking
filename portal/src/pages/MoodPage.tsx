import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  MOOD_MIN_RESPONSES,
  MOOD_OPTIONS,
  lastWeeks,
  mergeMood,
  moodOfAverage,
  summarizeMood,
  weekMonday,
  type MoodSummary,
  type MoodWeek,
  type OrgConfig,
  type WithId,
} from '@timetracking/shared';
import { ErrorState, Loading, PageHeader, Stat } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { ALLOWED_DOMAINS } from '../env';
import { addDays, zonedDate } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { buildOrgConfig, orgConfigToForm } from '../lib/payloads';
import { useLoad } from '../lib/useLoad';

/** Weeks in the chart. */
export const MOOD_WEEKS_SHOWN = 12;

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

/** "2–8 nov" or "29 sept – 5 oct". */
export function weekLabel(week: string): string {
  const from = weekMonday(week);
  const to = addDays(from, 6);
  const [, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [, tm, td] = to.split('-').map(Number) as [number, number, number];
  return fm === tm ? `${fd}–${td} ${MONTHS[tm - 1]}` : `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]}`;
}

/** "3,8" */
function formatAverage(n: number): string {
  return n.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function Average({ summary }: { summary: MoodSummary }) {
  if (summary.hidden || summary.average === null) return <span className="muted">—</span>;
  const face = moodOfAverage(summary.average);
  return (
    <span className="mood-avg">
      <span aria-hidden="true">{face.emoji}</span> {formatAverage(summary.average)}
      <span className="sr-only"> de 5 ({face.label.toLowerCase()})</span>
    </span>
  );
}

/** Distribution of a week as one bar split by score. */
function MoodBar({ summary }: { summary: MoodSummary }) {
  const parts = MOOD_OPTIONS.map((o, i) => ({ o, n: summary.counts[i] ?? 0 })).filter((p) => p.n > 0);
  const label = parts.map((p) => `${p.o.label}: ${p.n}`).join(', ');
  return (
    <span className="mood-bar" role="img" aria-label={label}>
      {parts.map((p) => (
        <span
          key={p.o.score}
          className={`mood-seg mood-${p.o.score}`}
          style={{ flexGrow: p.n }}
          title={`${p.o.emoji} ${p.o.label}: ${p.n} ${p.n === 1 ? 'respuesta' : 'respuestas'}`}
        />
      ))}
    </span>
  );
}

export function MoodLegend() {
  return (
    <ul className="mood-legend plain" aria-label="Escala">
      {MOOD_OPTIONS.map((o) => (
        <li key={o.score}>
          <span className={`mood-swatch mood-${o.score}`} aria-hidden="true" />
          <span aria-hidden="true">{o.emoji}</span> {o.label}
        </li>
      ))}
    </ul>
  );
}

/** Week by week, newest first. Weeks with few answers show no numbers. */
export function MoodWeeksTable({ weeks, counters }: { weeks: readonly string[]; counters: ReadonlyMap<string, MoodWeek> }) {
  return (
    <ul className="list mood-weeks" aria-label="Semanas">
      {[...weeks].reverse().map((w) => {
        const s = summarizeMood(counters.get(w));
        return (
          <li key={w} className="list-item mood-week">
            <span className="mood-week-label">{weekLabel(w)}</span>
            {s.total === 0 ? (
              <span className="muted small mood-week-bar">Sin respuestas</span>
            ) : s.hidden ? (
              <span className="muted small mood-week-bar">
                Menos de {MOOD_MIN_RESPONSES} respuestas: no se muestra para no identificar a nadie
              </span>
            ) : (
              <span className="mood-week-bar">
                <MoodBar summary={s} />
              </span>
            )}
            <span className="mood-week-avg">
              <Average summary={s} />
            </span>
            <span className="muted small mood-week-n">
              {s.hidden ? '' : `${s.total} ${s.total === 1 ? 'respuesta' : 'respuestas'}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The last 4 weeks against the 4 before. */
export function MoodSummaryStats({ weeks, counters }: { weeks: readonly string[]; counters: ReadonlyMap<string, MoodWeek> }) {
  const of = (ws: readonly string[]) => mergeMood(ws.map((w) => summarizeMood(counters.get(w))));
  const recent = of(weeks.slice(-4));
  const before = of(weeks.slice(-8, -4));
  const delta =
    !recent.hidden && !before.hidden && recent.average !== null && before.average !== null
      ? recent.average - before.average
      : null;
  return (
    <div className="stats">
      <Stat label="Ánimo, últimas 4 semanas" value={<Average summary={recent} />} hint="Promedio de 1 (muy mal) a 5 (muy bien)" />
      <Stat label="Respuestas, últimas 4 semanas" value={recent.hidden ? '—' : recent.total} hint={recent.hidden ? `Se muestran desde ${MOOD_MIN_RESPONSES}` : undefined} />
      <Stat
        label="Frente a las 4 anteriores"
        value={
          delta === null ? (
            '—'
          ) : (
            <span className={delta > 0.05 ? 'mood-up' : delta < -0.05 ? 'mood-down' : ''}>
              {delta > 0.05 ? '▲ ' : delta < -0.05 ? '▼ ' : ''}
              {delta > 0 ? '+' : ''}
              {formatAverage(delta)}
            </span>
          )
        }
        hint={delta === null ? 'Faltan respuestas para comparar' : undefined}
      />
    </div>
  );
}

function SettingsForm({ enabled, onSave }: { enabled: boolean; onSave(enabled: boolean): Promise<void> }) {
  const id = useId();
  const [value, setValue] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setValue(enabled), [enabled]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(value);
      setStatus({ ok: true, text: 'Configuración guardada. La extensión la aplica en unos minutos.' });
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)} noValidate>
      <label className="switch-row" htmlFor={`${id}-mood`}>
        <input
          id={`${id}-mood`}
          type="checkbox"
          checked={value}
          onChange={(e) => {
            setValue(e.target.checked);
            setStatus(null);
          }}
        />
        <span>
          <span className="strong">Preguntar "¿Cómo estuvo tu día?" al cerrar la jornada</span>
          <span className="muted small block">
            Cuando alguien cierra su jornada, la extensión le muestra cinco caras para responder con un clic (o
            "Omitir"), una vez al día. Es anónimo: solo se guarda cuántas personas eligieron cada cara en la semana, sin
            nombre ni día, y una semana con menos de {MOOD_MIN_RESPONSES} respuestas no se muestra.
          </span>
        </span>
      </label>
      {status ? (
        <p className={`banner ${status.ok ? 'ok' : 'error'}`} role={status.ok ? 'status' : 'alert'}>
          {status.text}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy || value === enabled}>
          {busy ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>
    </form>
  );
}

interface Loaded {
  config: OrgConfig | null;
  weeks: WithId<MoodWeek>[];
}

export function MoodPage() {
  const data = useData();
  const { uid, profile } = useAdmin();
  const load = useLoad<Loaded>(async () => {
    const [config, weeks] = await Promise.all([data.getOrgConfig(), data.listMoodWeeks()]);
    return { config, weeks };
  }, [data]);

  const weeks = lastWeeks(zonedDate(Date.now()), MOOD_WEEKS_SHOWN);
  const counters = new Map((load.data?.weeks ?? []).map(({ id, ...w }) => [id, w as MoodWeek]));
  const enabled = load.data?.config?.moodPulseEnabled === true;

  return (
    <>
      <PageHeader title="Pulso de ánimo" subtitle="Cómo se siente el equipo al cerrar el día, en forma anónima" />
      {load.error && load.data === undefined ? (
        <section className="card">
          <ErrorState error={load.error} onRetry={load.reload} />
        </section>
      ) : load.data === undefined ? (
        <section className="card">
          <Loading />
        </section>
      ) : (
        <>
          <section className="card">
            <SettingsForm
              enabled={enabled}
              onSave={async (on) => {
                // The rest of config/org as saved: this page only changes the mood pulse.
                const full = { ...orgConfigToForm(load.data?.config ?? null, ALLOWED_DOMAINS), moodPulseEnabled: on };
                await data.saveOrgConfig(buildOrgConfig(full, uid, Date.now(), profile.email));
                load.reload();
              }}
            />
          </section>
          <MoodSummaryStats weeks={weeks} counters={counters} />
          <section className="card" aria-labelledby="h-mood-weeks">
            <div className="card-head">
              <h2 id="h-mood-weeks">Semana a semana</h2>
            </div>
            <MoodLegend />
            <MoodWeeksTable weeks={weeks} counters={counters} />
            <p className="muted small">
              Semanas de lunes a domingo. Cada persona responde como máximo una vez al día; quien omite la pregunta no
              cuenta.
            </p>
          </section>
        </>
      )}
    </>
  );
}
