import { useEffect, useId, useState, type FormEvent } from 'react';
import { PulseTabs } from '../components/PulseTabs';
import {
  FEEDBACK_TONE_EMOJI,
  FEEDBACK_TONE_LABEL,
  lastWeeks,
  type Feedback,
  type FeedbackTone,
  type OrgConfig,
  type WithId,
} from '@timetracking/shared';
import { ConfirmDialog } from '../components/Modal';
import { Empty, ErrorState, Loading, PageHeader, Stat } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { ALLOWED_DOMAINS } from '../env';
import { zonedDate } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { buildOrgConfig, orgConfigToForm } from '../lib/payloads';
import { useLoad } from '../lib/useLoad';
import { weekLabel } from './MoodPage';

/** Weeks listed (older comments stay stored but are not shown). */
export const FEEDBACK_WEEKS_SHOWN = 12;

type Filter = 'all' | FeedbackTone;

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'positive', label: FEEDBACK_TONE_LABEL.positive },
  { value: 'negative', label: FEEDBACK_TONE_LABEL.negative },
];

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
      <label className="switch-row" htmlFor={`${id}-feedback`}>
        <input
          id={`${id}-feedback`}
          type="checkbox"
          checked={value}
          onChange={(e) => {
            setValue(e.target.checked);
            setStatus(null);
          }}
        />
        <span>
          <span className="strong">Permitir comentarios anónimos desde la extensión</span>
          <span className="muted small block">
            Cada persona puede dejar un comentario al día, marcado como "Algo bueno" o "Algo por mejorar". Aquí solo se
            ve el texto y la semana: no se guarda quién lo escribió, ni el día ni la hora.
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

/** Comments grouped by week, newest week first; inside a week, in the (random) order of their ids. */
export function FeedbackList({
  weeks,
  items,
  onDelete,
}: {
  weeks: readonly string[];
  items: readonly WithId<Feedback>[];
  onDelete(item: WithId<Feedback>): void;
}) {
  const groups = [...weeks]
    .reverse()
    .map((w) => ({ week: w, list: items.filter((f) => f.week === w).sort((a, b) => (a.id < b.id ? -1 : 1)) }))
    .filter((g) => g.list.length > 0);
  if (groups.length === 0) {
    return <Empty title="Sin comentarios">Cuando alguien deje un comentario desde la extensión, aparecerá aquí.</Empty>;
  }
  return (
    <div className="feedback-weeks">
      {groups.map((g) => (
        <section key={g.week} className="feedback-week" aria-label={`Semana ${weekLabel(g.week)}`}>
          <h3 className="feedback-week-label">
            {weekLabel(g.week)} <span className="muted small">· {g.list.length === 1 ? '1 comentario' : `${g.list.length} comentarios`}</span>
          </h3>
          <ul className="list plain">
            {g.list.map((f) => (
              <li key={f.id} className={`list-item feedback-item ${f.tone}`}>
                <span className={`chip small-chip ${f.tone === 'positive' ? 'ok' : 'warn'}`}>
                  <span aria-hidden="true">{FEEDBACK_TONE_EMOJI[f.tone]}</span> {FEEDBACK_TONE_LABEL[f.tone]}
                </span>
                <p className="feedback-text">{f.text}</p>
                <button type="button" className="btn small-btn danger-outline feedback-delete" onClick={() => onDelete(f)}>
                  Eliminar
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface Loaded {
  config: OrgConfig | null;
  items: WithId<Feedback>[];
}

export function FeedbackPage() {
  const data = useData();
  const { uid, profile } = useAdmin();
  const weeks = lastWeeks(zonedDate(Date.now()), FEEDBACK_WEEKS_SHOWN);
  const fromWeek = weeks[0]!;
  const load = useLoad<Loaded>(async () => {
    const [config, items] = await Promise.all([data.getOrgConfig(), data.listFeedback(fromWeek)]);
    return { config, items };
  }, [data, fromWeek]);
  const [filter, setFilter] = useState<Filter>('all');
  const [deleting, setDeleting] = useState<WithId<Feedback> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = load.data?.config?.feedbackEnabled === true;
  const items = load.data?.items ?? [];
  const recentWeeks = new Set(weeks.slice(-4));
  const recent = items.filter((f) => recentWeeks.has(f.week));
  const count = (tone: FeedbackTone) => recent.filter((f) => f.tone === tone).length;
  const shown = filter === 'all' ? items : items.filter((f) => f.tone === filter);

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await data.deleteFeedback(deleting.id);
      setDeleting(null);
      setError(null);
      load.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Comentarios" subtitle="Lo que el equipo cuenta de su día, bueno o por mejorar, sin nombres" />
      <PulseTabs />
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
                // The rest of config/org as saved: this page only changes the comments.
                const full = { ...orgConfigToForm(load.data?.config ?? null, ALLOWED_DOMAINS), feedbackEnabled: on };
                await data.saveOrgConfig(buildOrgConfig(full, uid, Date.now(), profile.email));
                load.reload();
              }}
            />
          </section>
          <div className="stats">
            <Stat label="Comentarios, últimas 4 semanas" value={recent.length} />
            <Stat label={`${FEEDBACK_TONE_EMOJI.positive} ${FEEDBACK_TONE_LABEL.positive}`} value={count('positive')} />
            <Stat label={`${FEEDBACK_TONE_EMOJI.negative} ${FEEDBACK_TONE_LABEL.negative}`} value={count('negative')} />
          </div>
          <section className="card" aria-labelledby="h-feedback">
            <div className="card-head">
              <h2 id="h-feedback">Semana a semana</h2>
              <div className="segmented" role="group" aria-label="Filtrar">
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    className={filter === f.value ? 'active' : ''}
                    aria-pressed={filter === f.value}
                    onClick={() => setFilter(f.value)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <FeedbackList weeks={weeks} items={shown} onDelete={setDeleting} />
            <p className="muted small">
              Últimas {FEEDBACK_WEEKS_SHOWN} semanas, de lunes a domingo. Dentro de cada semana el orden es al azar, para
              que no se pueda deducir quién escribió por la hora.
            </p>
          </section>
        </>
      )}
      {deleting ? (
        <ConfirmDialog
          title="Eliminar comentario"
          message={<p>El comentario dejará de verse y no se puede recuperar. Úsalo para comentarios ofensivos o que identifiquen a alguien.</p>}
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
