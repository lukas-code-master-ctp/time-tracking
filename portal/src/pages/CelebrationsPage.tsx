import { useState } from 'react';
import {
  dayMonthLabel,
  upcomingCelebrations,
  yearsLabel,
  type Celebration,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { PeopleTabs } from '../components/PeopleTabs';
import { initials } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import {
  buildCelebration,
  celebrationFormError,
  celebrationToForm,
  sameForm,
  type CelebrationForm,
} from '../lib/celebrations';
import { zonedDate } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { useLoad } from '../lib/useLoad';

/** Days ahead shown in "Próximas fechas" (the popup shows 7). */
const UPCOMING_DAYS = 30;

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function when(daysAway: number, date: string): string {
  if (daysAway === 0) return 'Hoy';
  if (daysAway === 1) return 'Mañana';
  return `${dayMonthLabel(date)} · en ${daysAway} días`;
}

/**
 * Colaboradores › Cumpleaños (spec 2026-11-05-cumpleanos-aniversarios): the
 * birthday (day and month) and hire date of each person, which the extension
 * popup shows to the whole team on the day and the week before.
 */
export function CelebrationsPage() {
  const data = useData();
  const load = useLoad(async () => {
    const [users, celebrations] = await Promise.all([data.listUsers(), data.listCelebrations()]);
    return { users, celebrations: new Map(celebrations.map((c) => [c.id, c])) };
  }, [data]);
  const today = zonedDate(Date.now());

  const users = [...(load.data?.users ?? [])].sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) ||
      (a.displayName || a.email).localeCompare(b.displayName || b.email, 'es'),
  );
  const upcoming = load.data ? upcomingCelebrations([...load.data.celebrations.values()], today, UPCOMING_DAYS) : [];

  return (
    <>
      <PageHeader
        title="Colaboradores"
        subtitle="Registra el cumpleaños y la fecha de ingreso de cada persona. La extensión avisa al equipo el mismo día y durante la semana anterior."
      />
      <PeopleTabs />
      {load.error && !load.data ? (
        <section className="card">
          <ErrorState error={load.error} onRetry={load.reload} />
        </section>
      ) : !load.data ? (
        <section className="card">
          <Loading />
        </section>
      ) : (
        <>
          <section className="card" aria-labelledby="upcoming-title">
            <div className="card-head">
              <h2 id="upcoming-title">Próximas fechas</h2>
              <span className="muted small">Próximos {UPCOMING_DAYS} días</span>
            </div>
            {upcoming.length === 0 ? (
              <p className="muted small">No hay cumpleaños ni aniversarios en los próximos {UPCOMING_DAYS} días.</p>
            ) : (
              <ul className="celebration-list">
                {upcoming.map((u) => (
                  <li key={`${u.uid}-${u.kind}`} className={u.daysAway === 0 ? 'today' : undefined}>
                    <span className="celebration-icon" aria-hidden="true">
                      {u.kind === 'birthday' ? '🎂' : '🎉'}
                    </span>
                    <span className="celebration-text">
                      <strong>{u.name}</strong>
                      <span className="muted">
                        {u.kind === 'birthday' ? 'Cumpleaños' : `${yearsLabel(u.years ?? 0)} en la empresa`}
                      </span>
                    </span>
                    <span className={`chip${u.daysAway === 0 ? ' ok' : ''}`}>{when(u.daysAway, u.date)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card flush" aria-label="Fechas de cada persona">
            {users.length === 0 ? (
              <Empty title="Aún no hay colaboradores" />
            ) : (
              <ul className="list">
                {users.map((u) => (
                  <CelebrationRow
                    key={u.id}
                    user={u}
                    current={load.data!.celebrations.get(u.id) ?? null}
                    today={today}
                    onSaved={load.reload}
                  />
                ))}
              </ul>
            )}
          </section>
          <p className="muted small footnote">
            Del cumpleaños solo se guarda el día y el mes, nunca el año. Las personas desactivadas no aparecen en la extensión.
          </p>
        </>
      )}
    </>
  );
}

function CelebrationRow({
  user,
  current,
  today,
  onSaved,
}: {
  user: WithId<UserProfile>;
  current: WithId<Celebration> | null;
  today: string;
  onSaved: () => void;
}) {
  const data = useData();
  const { uid: me } = useAdmin();
  const saved = celebrationToForm(current);
  const [form, setForm] = useState<CelebrationForm>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const name = user.displayName || user.email;
  const dirty = !sameForm(form, saved);
  const invalid = celebrationFormError(form, today);
  const id = `cel-${user.id}`;

  const set = (patch: Partial<CelebrationForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setOk(false);
    setError(null);
  };

  const save = async (): Promise<void> => {
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await data.saveCelebration(user.id, buildCelebration(user, form, me, Date.now()));
      setOk(true);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`list-item${user.status === 'disabled' ? ' dimmed' : ''}`}>
      <div className="person">
        <span className="avatar" aria-hidden="true">
          {initials(name)}
        </span>
        <span className="person-text">
          <span className="person-name">{name}</span>
          <span className="person-email">{user.email}</span>
        </span>
      </div>
      <form
        className="celebration-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="celebration-birthday">
          <legend>Cumpleaños</legend>
          <label className="sr-only" htmlFor={`${id}-day`}>
            Día del cumpleaños de {name}
          </label>
          <select id={`${id}-day`} value={form.birthDay} onChange={(e) => set({ birthDay: e.target.value })}>
            <option value="">Día</option>
            {Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).map((d) => (
              <option key={d} value={d}>
                {Number(d)}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`${id}-month`}>
            Mes del cumpleaños de {name}
          </label>
          <select id={`${id}-month`} value={form.birthMonth} onChange={(e) => set({ birthMonth: e.target.value })}>
            <option value="">Mes</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={String(i + 1).padStart(2, '0')}>
                {m}
              </option>
            ))}
          </select>
        </fieldset>
        <div className="celebration-hire">
          <label htmlFor={`${id}-hire`}>Ingreso</label>
          <input
            id={`${id}-hire`}
            type="date"
            value={form.hireDate}
            max={today}
            onChange={(e) => set({ hireDate: e.target.value })}
            aria-label={`Fecha de ingreso de ${name}`}
          />
        </div>
        <button type="submit" className="btn small-btn primary" disabled={busy || !dirty}>
          {busy ? 'Guardando…' : 'Guardar'}
        </button>
        {ok && !dirty ? (
          <span className="small ok-text" role="status">
            Guardado
          </span>
        ) : null}
      </form>
      {error ? (
        <p className="field-error celebration-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
