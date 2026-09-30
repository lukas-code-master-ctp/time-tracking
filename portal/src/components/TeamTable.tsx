import { Link, useNavigate } from 'react-router';
import { formatDuration, type ComplianceTotals, type TeamSummary } from '@timetracking/shared';
import { formatRelativeDateTime } from '../lib/dates';
import type { MemberCompliance, TeamCompliance } from '../lib/schedule';
import { ActivityMeter } from './ui';

interface Props {
  team: TeamSummary;
  now: number;
  /** Day opened in the detail page (`YYYY-MM-DD`). */
  detailDate: string;
  /** Schedule compliance: its columns are shown only when there is a schedule. */
  compliance?: TeamCompliance | null;
}

export const COMPLIANCE_HEADERS = [
  'Esperadas',
  'En horario',
  'Fuera de horario',
  'Atrasos',
  'Sin conexión en horario',
  'Ausencias',
] as const;

/** Schedule cells of one row (or the totals). `c` null = the person has no schedule. */
function ComplianceCells({ c, source }: { c: ComplianceTotals | null; source?: MemberCompliance['source'] }) {
  if (!c) {
    return (
      <>
        <td className="num sch-group">
          <span className="muted">Sin horario</span>
        </td>
        {COMPLIANCE_HEADERS.slice(1).map((h) => (
          <td key={h} className="num">
            <span className="muted">—</span>
          </td>
        ))}
      </>
    );
  }
  return (
    <>
      <td className="num sch-group">
        <span className="strong">{formatDuration(c.expectedSoFarSeconds)}</span>
        {c.expectedSeconds !== c.expectedSoFarSeconds ? (
          <span className="sub" title="Horas de horario en todo el periodo">
            de {formatDuration(c.expectedSeconds)}
          </span>
        ) : null}
        {source === 'personal' ? <span className="sub">personalizado</span> : null}
      </td>
      <td className="num">{formatDuration(c.inScheduleSeconds)}</td>
      <td className="num">{formatDuration(c.outsideScheduleSeconds)}</td>
      <td className="num">
        {c.lateCount === 0 ? (
          '0'
        ) : (
          <>
            <span className="strong">{c.lateCount}</span>
            <span className="sub">{formatDuration(c.lateSeconds)}</span>
          </>
        )}
      </td>
      <td className="num">{formatDuration(c.offlineSeconds)}</td>
      <td className="num">{c.absentDays === 0 ? '0' : `${c.absentDays} ${c.absentDays === 1 ? 'día' : 'días'}`}</td>
    </>
  );
}

export function memberHref(uid: string, date: string): string {
  return `/colaborador/${encodeURIComponent(uid)}?fecha=${date}`;
}

export function TeamTable({ team, now, detailDate, compliance = null }: Props) {
  const navigate = useNavigate();
  const { rows, totals } = team;
  return (
    <div className="table-wrap" tabIndex={0} aria-label="Resumen del equipo (desplázate para ver todas las columnas)">
      <table className={`table team-table${compliance ? ' with-schedule' : ''}`}>
        <thead>
          <tr>
            <th scope="col">Colaborador</th>
            <th scope="col" className="num">
              Horas
            </th>
            <th scope="col">Actividad</th>
            <th scope="col">Estado</th>
            <th scope="col" className="num">
              En reunión
            </th>
            <th scope="col" className="num">
              Fuera de Chrome
            </th>
            <th scope="col">Última actividad</th>
            <th scope="col" className="num">
              Jornadas
            </th>
            {compliance
              ? COMPLIANCE_HEADERS.map((h, i) => (
                  <th key={h} scope="col" className={i === 0 ? 'num sch-group' : 'num'}>
                    {h}
                  </th>
                ))
              : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const href = memberHref(r.uid, detailDate);
            return (
              <tr
                key={r.uid}
                className="clickable"
                onClick={(e) => {
                  // Let the link handle its own clicks (and ctrl/cmd+click).
                  if ((e.target as HTMLElement).closest('a')) return;
                  void navigate(href);
                }}
              >
                <td>
                  <Link to={href} className="person">
                    <span className="avatar" aria-hidden="true">
                      {initials(r.displayName)}
                    </span>
                    <span className="person-text">
                      <span className="person-name">{r.displayName}</span>
                      <span className="person-email">{r.email}</span>
                    </span>
                  </Link>
                </td>
                <td className="num">
                  <span className="strong">{formatDuration(r.sessionSeconds)}</span>
                  {r.trackedSeconds > 0 ? <span className="sub">medidas {formatDuration(r.trackedSeconds)}</span> : null}
                </td>
                <td>
                  <ActivityMeter percent={r.activityPercent} measured={r.trackedSeconds > 0} />
                </td>
                <td>
                  {r.status === 'disabled' ? (
                    <span className="chip">Desactivado</span>
                  ) : r.inSession ? (
                    <span className="chip ok">
                      <span className="dot" aria-hidden="true" />
                      En jornada
                    </span>
                  ) : (
                    <span className="chip muted-chip">Fuera</span>
                  )}
                </td>
                <td className="num">{r.trackedSeconds > 0 ? formatDuration(r.meetingSeconds) : '—'}</td>
                <td className="num">{r.trackedSeconds > 0 ? formatDuration(r.outsideChromeSeconds) : '—'}</td>
                <td>{r.lastActivityAt === null ? <span className="muted">—</span> : formatRelativeDateTime(r.lastActivityAt, now)}</td>
                <td className="num">{r.sessionCount}</td>
                {compliance ? (
                  <ComplianceCells c={compliance.byUid.get(r.uid)?.totals ?? null} source={compliance.byUid.get(r.uid)?.source} />
                ) : null}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total ({totals.members})</th>
            <td className="num">
              <span className="strong">{formatDuration(totals.sessionSeconds)}</span>
              {totals.trackedSeconds > 0 ? <span className="sub">medidas {formatDuration(totals.trackedSeconds)}</span> : null}
            </td>
            <td>
              <ActivityMeter percent={totals.activityPercent} measured={totals.trackedSeconds > 0} />
            </td>
            <td>{totals.membersInSession} en jornada</td>
            <td className="num">{totals.trackedSeconds > 0 ? formatDuration(totals.meetingSeconds) : '—'}</td>
            <td className="num">{totals.trackedSeconds > 0 ? formatDuration(totals.outsideChromeSeconds) : '—'}</td>
            <td />
            <td className="num">{rows.reduce((n, r) => n + r.sessionCount, 0)}</td>
            {compliance ? <ComplianceCells c={compliance.scheduled > 0 ? compliance.totals : null} /> : null}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}
