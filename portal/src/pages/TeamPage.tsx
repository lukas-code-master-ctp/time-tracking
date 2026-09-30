import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { formatDuration, teamSummaryToCsv, type ActivitySlot } from '@timetracking/shared';
import { RangePicker } from '../components/RangePicker';
import { TeamTable } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader, Stat, ActivityMeter } from '../components/ui';
import { useData } from '../data/context';
import { describeRange, isRangePreset, presetRange, rangeIncludes, startOfDay, zonedDate, type DateRange } from '../lib/dates';
import { downloadText } from '../lib/download';
import { complianceCsvExtra, teamCompliance, type ScheduleContext } from '../lib/schedule';
import { buildTeam, mergeActivity } from '../lib/team';
import { useLoad } from '../lib/useLoad';

const REFRESH_MS = 60_000;

/** Range from the URL (`?rango=hoy|…&desde=&hasta=`), "today" by default. */
export function rangeFromParams(params: URLSearchParams, now: number): DateRange {
  const preset = params.get('rango');
  if (!isRangePreset(preset)) return presetRange('today', now);
  return presetRange(preset, now, undefined, { fromDate: params.get('desde') ?? '', toDate: params.get('hasta') ?? '' });
}

export function TeamPage() {
  const data = useData();
  const [params, setParams] = useSearchParams();
  // The range is resolved against "now" at render time; `today` rolls over at midnight.
  const range = rangeFromParams(params, Date.now());

  // Activity already read for this range; automatic refreshes re-read only
  // from `since` (see mergeActivity). `full` forces a whole read ("Actualizar").
  const cache = useRef<{ from: number; to: number; since: number; slots: ActivitySlot[] } | null>(null);
  const full = useRef(true);
  // General schedule and exceptions: read once, and again only with "Actualizar".
  const schedules = useRef<ScheduleContext | null>(null);

  const load = useLoad(async () => {
    const startedAt = Date.now();
    const prev =
      !full.current && cache.current && cache.current.from === range.from && cache.current.to === range.to
        ? cache.current
        : null;
    const readSchedules = full.current || !schedules.current;
    full.current = false;
    const since = prev ? Math.max(range.from, prev.since) : range.from;
    const [users, fresh, sessions, ctx] = await Promise.all([
      data.listUsers(),
      data.listActivity(prev ? { from: since, to: range.to } : range),
      data.listSessions(range),
      readSchedules
        ? Promise.all([data.getScheduleConfig(), data.listPersonSchedules()]).then(
            ([config, persons]): ScheduleContext => ({ config, persons: new Map(persons.map(({ id, ...p }) => [id, p])) }),
          )
        : Promise.resolve(schedules.current!),
    ]);
    schedules.current = ctx;
    const slots = prev ? mergeActivity(prev.slots, fresh, since) : fresh;
    cache.current = {
      from: range.from,
      to: range.to,
      since: Math.max(range.from, startOfDay(zonedDate(startedAt))),
      slots,
    };
    const now = Date.now();
    const team = buildTeam(users, slots, sessions, range, now);
    const compliance = teamCompliance(
      team.rows.map((r) => r.uid),
      sessions,
      ctx,
      range.fromDate,
      range.toDate,
      now,
      new Map(users.map((u) => [u.id, u.createdAt])),
    );
    return { team, compliance, now };
  }, [data, range.from, range.to]);

  const live = rangeIncludes(range, Date.now());
  const { reload } = load;
  const reloadAll = useCallback(() => {
    full.current = true;
    reload();
  }, [reload]);
  useEffect(() => {
    if (!live) return;
    // No reads while the tab is hidden; catch up when it is shown again.
    const refresh = (): void => {
      if (!document.hidden) reload();
    };
    const t = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [live, reload]);

  const detailDate = useMemo(() => {
    const today = zonedDate(Date.now());
    return range.toDate < today ? range.toDate : today;
  }, [range.toDate]);

  const setPreset = (preset: DateRange['preset']): void => {
    if (preset === 'custom') {
      setParams({ rango: 'custom', desde: range.fromDate, hasta: range.toDate });
    } else {
      setParams(preset === 'today' ? {} : { rango: preset });
    }
  };

  const exportCsv = (): void => {
    if (!load.data) return;
    const { compliance } = load.data;
    const csv = teamSummaryToCsv(load.data.team, {
      separator: ';',
      decimalSeparator: ',',
      bom: true,
      ...(compliance ? { extra: complianceCsvExtra(compliance) } : {}),
    });
    downloadText(`equipo_${range.fromDate}_${range.toDate}.csv`, csv, 'text/csv;charset=utf-8');
  };

  const team = load.data?.team;
  return (
    <>
      <PageHeader
        title="Equipo"
        subtitle={`Horas y actividad por colaborador · ${describeRange(range)} (hora de Chile)`}
        actions={
          <>
            <button type="button" className="btn" onClick={reloadAll} disabled={load.loading}>
              {load.loading && team ? 'Actualizando…' : 'Actualizar'}
            </button>
            <button type="button" className="btn primary" onClick={exportCsv} disabled={!team || team.rows.length === 0}>
              Exportar CSV
            </button>
          </>
        }
      />
      <RangePicker
        range={range}
        onPreset={setPreset}
        onCustom={(desde, hasta) => setParams({ rango: 'custom', desde, hasta })}
      />

      {team ? (
        <section className="stats" aria-label="Totales del periodo">
          <Stat label="En jornada ahora" value={`${team.totals.membersInSession} de ${team.totals.members}`} />
          <Stat label="Horas en jornada" value={formatDuration(team.totals.sessionSeconds)} hint={`medidas ${formatDuration(team.totals.trackedSeconds)}`} />
          <Stat
            label="Actividad promedio"
            value={<ActivityMeter percent={team.totals.activityPercent} measured={team.totals.trackedSeconds > 0} />}
          />
          <Stat label="En reunión" value={formatDuration(team.totals.meetingSeconds)} />
          <Stat label="Fuera de Chrome" value={formatDuration(team.totals.outsideChromeSeconds)} />
        </section>
      ) : null}

      {team && load.data?.compliance && load.data.compliance.scheduled > 0 ? (
        <section className="stats" aria-label="Horario del periodo">
          <Stat
            label="Horas esperadas"
            value={formatDuration(load.data.compliance.totals.expectedSoFarSeconds)}
            hint={`en horario ${formatDuration(load.data.compliance.totals.inScheduleSeconds)}`}
          />
          <Stat label="Fuera de horario" value={formatDuration(load.data.compliance.totals.outsideScheduleSeconds)} />
          <Stat
            label="Atrasos"
            value={String(load.data.compliance.totals.lateCount)}
            hint={load.data.compliance.totals.lateCount > 0 ? `${formatDuration(load.data.compliance.totals.lateSeconds)} en total` : undefined}
          />
          <Stat label="Sin conexión en horario" value={formatDuration(load.data.compliance.totals.offlineSeconds)} />
          <Stat label="Ausencias" value={`${load.data.compliance.totals.absentDays} ${load.data.compliance.totals.absentDays === 1 ? 'día' : 'días'}`} />
        </section>
      ) : null}

      {team && load.data?.compliance ? (
        <p className="muted small table-hint">Desliza la tabla hacia la derecha para ver las columnas de horario por persona.</p>
      ) : null}

      <section className="card flush" aria-label="Colaboradores">
        {load.error && !team ? (
          <ErrorState error={load.error} onRetry={reloadAll} />
        ) : !team ? (
          <Loading label="Cargando el equipo…" />
        ) : team.rows.length === 0 ? (
          <Empty title="Aún no hay colaboradores">Invita a tu equipo desde Invitaciones.</Empty>
        ) : (
          <>
            {load.error ? (
              <p className="banner error inset" role="alert">
                No se pudo actualizar. Se muestran los últimos datos cargados.
              </p>
            ) : null}
            <TeamTable team={team} now={load.data!.now} detailDate={detailDate} compliance={load.data!.compliance} />
          </>
        )}
      </section>
      <p className="muted small footnote">
        “Horas” es el tiempo de jornada abierta (hasta la última señal de la extensión); “medidas”, el tiempo con datos de
        actividad. “En reunión” es el tiempo en reuniones web (Meet, Zoom, Teams…) sin usar teclado ni mouse: no sube ni baja
        el % de actividad. “En jornada” indica el estado actual, sin importar el periodo elegido.
      </p>
      {load.data?.compliance ? (
        <p className="muted small footnote">
          Horario: “Esperadas” son las horas de horario hasta ahora, sin la colación ni los feriados ni los días libres (“de …”, las de todo el periodo); “En
          horario”, el tiempo de jornada dentro de ellas; “Fuera de horario”, el tiempo de jornada fuera del horario y de la
          colación. “Atrasos”: cuántos días la llegada superó la tolerancia, y cuánto sumaron. “Sin conexión en horario” es lo esperado hasta
          ahora sin jornada abierta, y una ausencia es un día laboral ya terminado sin jornada. Los días antes de que la
          persona se uniera no cuentan. Se calcula con el horario vigente.
        </p>
      ) : null}
    </>
  );
}
