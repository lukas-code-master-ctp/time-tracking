import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { formatDuration, teamSummaryToCsv, type ActivitySlot } from '@timetracking/shared';
import { RangePicker } from '../components/RangePicker';
import { TeamTable } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader, Stat, ActivityMeter } from '../components/ui';
import { useData } from '../data/context';
import { describeRange, isRangePreset, presetRange, rangeIncludes, startOfDay, zonedDate, type DateRange } from '../lib/dates';
import { downloadText } from '../lib/download';
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

  const load = useLoad(async () => {
    const startedAt = Date.now();
    const prev =
      !full.current && cache.current && cache.current.from === range.from && cache.current.to === range.to
        ? cache.current
        : null;
    full.current = false;
    const since = prev ? Math.max(range.from, prev.since) : range.from;
    const [users, fresh, sessions] = await Promise.all([
      data.listUsers(),
      data.listActivity(prev ? { from: since, to: range.to } : range),
      data.listSessions(range),
    ]);
    const slots = prev ? mergeActivity(prev.slots, fresh, since) : fresh;
    cache.current = {
      from: range.from,
      to: range.to,
      since: Math.max(range.from, startOfDay(zonedDate(startedAt))),
      slots,
    };
    const now = Date.now();
    return { team: buildTeam(users, slots, sessions, range, now), now };
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
    const csv = teamSummaryToCsv(load.data.team, { separator: ';', decimalSeparator: ',', bom: true });
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
          <Stat label="Actividad promedio" value={<ActivityMeter percent={team.totals.activityPercent} />} />
          <Stat label="Fuera de Chrome" value={formatDuration(team.totals.outsideChromeSeconds)} />
        </section>
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
            <TeamTable team={team} now={load.data!.now} detailDate={detailDate} />
          </>
        )}
      </section>
      <p className="muted small footnote">
        “Horas” es el tiempo de jornada abierta (hasta la última señal de la extensión); “medidas”, el tiempo con datos de
        actividad. “En jornada” indica el estado actual, sin importar el periodo elegido.
      </p>
    </>
  );
}
