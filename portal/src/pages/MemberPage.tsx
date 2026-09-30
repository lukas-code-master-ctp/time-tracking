import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { formatDuration, summarizeMember } from '@timetracking/shared';
import { ScreenshotGallery } from '../components/Screenshots';
import { Timeline } from '../components/Timeline';
import { ActivityMeter, BarList, Empty, ErrorState, Loading, PageHeader, Stat } from '../components/ui';
import { useData } from '../data/context';
import { addDays, dayBounds, formatLongDate, isValidDate, zonedDate } from '../lib/dates';
import { sessionViews } from '../lib/team';
import { buildTimeline } from '../lib/timeline';
import { useLoad } from '../lib/useLoad';

export function MemberPage() {
  const { uid = '' } = useParams();
  const data = useData();
  const [params, setParams] = useSearchParams();
  const today = zonedDate(Date.now());
  const raw = params.get('fecha') ?? '';
  const date = isValidDate(raw) ? raw : today;
  const day = useMemo(() => dayBounds(date), [date]);
  const [openShot, setOpenShot] = useState<string | null>(null);

  const load = useLoad(async () => {
    const [user, config, slots, sessions, shots] = await Promise.all([
      data.getUser(uid),
      data.getOrgConfig(),
      data.listActivity(day, uid),
      data.listSessions(day, uid),
      data.listScreenshots(uid, day),
    ]);
    return { user, config, slots, sessions, shots, now: Date.now() };
  }, [data, uid, day.from, day.to]);

  const view = useMemo(() => {
    if (!load.data) return null;
    const { slots, sessions, shots, now } = load.data;
    return {
      summary: summarizeMember(slots, sessions, { from: day.from, to: day.to, now, topN: 10 }),
      timeline: buildTimeline(day.from, day.to, slots, shots),
      sessions: sessionViews(sessions, day, now),
      shots: [...shots].sort((a, b) => a.takenAt - b.takenAt),
    };
  }, [load.data, day]);

  const goTo = (d: string): void => {
    setOpenShot(null);
    setParams(d === today ? {} : { fecha: d });
  };

  const user = load.data?.user;
  const title = user ? user.displayName || user.email : 'Colaborador';

  return (
    <>
      <p className="breadcrumb">
        <Link to="/">← Equipo</Link>
      </p>
      <PageHeader
        title={title}
        subtitle={user ? `${user.email}${user.status === 'disabled' ? ' · desactivado' : ''}` : undefined}
        actions={
          <div className="day-picker" role="group" aria-label="Día">
            <button type="button" className="btn" onClick={() => goTo(addDays(date, -1))} aria-label="Día anterior">
              ←
            </button>
            <label className="sr-only" htmlFor="day">
              Día
            </label>
            <input
              id="day"
              type="date"
              value={date}
              max={today}
              onChange={(e) => {
                if (isValidDate(e.target.value)) goTo(e.target.value);
              }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => goTo(addDays(date, 1))}
              disabled={date >= today}
              aria-label="Día siguiente"
            >
              →
            </button>
          </div>
        }
      />
      <p className="muted day-label">{formatLongDate(date)}</p>

      {load.error && !load.data ? (
        <section className="card">
          <ErrorState error={load.error} onRetry={load.reload} />
        </section>
      ) : !load.data || !view ? (
        <section className="card">
          <Loading />
        </section>
      ) : !user ? (
        <section className="card">
          <Empty title="No existe este colaborador">
            <Link to="/">Volver al equipo</Link>
          </Empty>
        </section>
      ) : (
        <>
          <section className="stats" aria-label="Resumen del día">
            <Stat label="Horas en jornada" value={formatDuration(view.summary.sessionSeconds)} hint={`medidas ${formatDuration(view.summary.trackedSeconds)}`} />
            <Stat
              label="Actividad"
              value={<ActivityMeter percent={view.summary.activityPercent} measured={view.summary.trackedSeconds > 0} />}
            />
            <Stat label="En reunión" value={formatDuration(view.summary.meetingSeconds)} hint="no cuenta en la actividad" />
            <Stat label="Fuera de Chrome" value={formatDuration(view.summary.outsideChromeSeconds)} />
            <Stat label="Jornadas" value={String(view.sessions.length)} />
          </section>

          <section className="card" aria-labelledby="h-sessions">
            <h2 id="h-sessions">Jornadas del día</h2>
            {view.sessions.length === 0 ? (
              <p className="muted">No hubo jornadas este día.</p>
            ) : (
              <div className="table-wrap" tabIndex={0} aria-label="Jornadas del día">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th scope="col">Inicio</th>
                      <th scope="col">Fin</th>
                      <th scope="col" className="num">
                        Duración
                      </th>
                      <th scope="col">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.sessions.map((s) => (
                      <tr key={s.id}>
                        <td>{s.start}</td>
                        <td>{s.end}</td>
                        <td className="num">{formatDuration(s.durationSeconds)}</td>
                        <td>
                          <span className={`chip ${s.state === 'live' ? 'ok' : s.state === 'auto' || s.state === 'stale' ? 'warn' : 'muted-chip'}`}>
                            {s.note}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="h-timeline">
            <h2 id="h-timeline">Línea de tiempo</h2>
            {view.timeline.rows.length === 0 ? (
              <p className="muted">Sin actividad registrada este día.</p>
            ) : (
              <Timeline timeline={view.timeline} onOpenScreenshot={setOpenShot} />
            )}
          </section>

          <div className="two-col">
            <section className="card" aria-labelledby="h-domains">
              <h2 id="h-domains">Sitios más usados</h2>
              <BarList
                items={view.summary.topDomains.map((d) => ({ key: d.domain, label: d.domain, seconds: d.seconds }))}
                emptyText="Sin sitios registrados."
              />
            </section>
            <section className="card" aria-labelledby="h-urls">
              <h2 id="h-urls">Páginas más usadas</h2>
              <BarList
                items={view.summary.topUrls.map((u) => ({ key: u.url, label: u.url.replace(/^https?:\/\//, ''), title: u.url, seconds: u.seconds }))}
                emptyText="Sin páginas registradas."
              />
            </section>
          </div>

          <section className="card" aria-labelledby="h-shots">
            <h2 id="h-shots">Capturas de pantalla</h2>
            {!load.data.config?.screenshotsEnabled ? (
              <p className="banner warn">
                Las capturas están desactivadas en <Link to="/configuracion">Configuración</Link>
                {view.shots.length > 0 ? '. Se muestran las tomadas mientras estaban activas.' : '.'}
              </p>
            ) : null}
            {view.shots.length === 0 ? (
              <p className="muted">No hay capturas de este día.</p>
            ) : (
              <ScreenshotGallery shots={view.shots} openId={openShot} onOpen={setOpenShot} onClose={() => setOpenShot(null)} />
            )}
          </section>
        </>
      )}
    </>
  );
}
