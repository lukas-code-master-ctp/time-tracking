import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  isFieldWorker,
  membersOf,
  readDailyReportSettings,
  sortGroups,
  type DailyReport,
  type OrgConfig,
  type PersonGroup,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { initials } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import { ALLOWED_DOMAINS } from '../env';
import { addDays, zonedDate } from '../lib/dates';
import { errorMessage } from '../lib/messages';
import { buildOrgConfig, orgConfigToForm } from '../lib/payloads';
import { useLoad } from '../lib/useLoad';

const nameOf = (u: UserProfile): string => u.displayName || u.email;

const time = (ms: number): string =>
  new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);

/** "viernes 13 de noviembre" */
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = Date.UTC(y, m - 1, d);
  const weekday = new Intl.DateTimeFormat('es-CL', { timeZone: 'UTC', weekday: 'long' }).format(at);
  const month = new Intl.DateTimeFormat('es-CL', { timeZone: 'UTC', month: 'long' }).format(at);
  return `${weekday} ${d} de ${month}`;
}

export interface DailyReportsSettingsProps {
  enabled: boolean;
  groupIds: readonly string[];
  groups: readonly WithId<PersonGroup>[];
  onSave(enabled: boolean, groupIds: string[]): Promise<void>;
}

/** On/off and the groups asked for the report. */
export function DailyReportsSettings({ enabled, groupIds, groups, onSave }: DailyReportsSettingsProps) {
  const id = useId();
  const [on, setOn] = useState(enabled);
  const [picked, setPicked] = useState<Set<string>>(new Set(groupIds));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setOn(enabled), [enabled]);
  useEffect(() => setPicked(new Set(groupIds)), [groupIds]);

  const known = picked.size > 0 ? [...picked].filter((g) => groups.some((x) => x.id === g)) : [];
  const dirty = on !== enabled || known.length !== groupIds.length || known.some((g) => !groupIds.includes(g));

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(on, known);
      setStatus({ ok: true, text: 'Configuración guardada. La extensión la aplica en unos minutos.' });
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)} noValidate>
      <label className="switch-row" htmlFor={`${id}-on`}>
        <input
          id={`${id}-on`}
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setStatus(null);
          }}
        />
        <span>
          <span className="strong">Pedir la minuta del día al cerrar la jornada</span>
          <span className="muted small block">
            Cuando alguien de los grupos elegidos cierra su jornada, la extensión le recuerda enviar una minuta de su día. La
            puede escribir o grabar un audio de hasta 4 minutos: la IA lo transcribe y arma la minuta, que la persona revisa
            antes de enviarla. El audio no se guarda. Las personas de terreno entran desde el celular a{' '}
            {window.location.host || 'app.mipegahr.cl'} con su correo, llegan directo a su minuta y reciben un correo con
            el enlace al terminar su horario.
          </span>
        </span>
      </label>
      <fieldset disabled={!on}>
        <legend>Quiénes envían minuta</legend>
        <p className="muted small">
          Las personas marcadas como <strong>Terreno</strong> en <Link to="/colaboradores">Colaboradores</Link> siempre la
          envían. Además puedes pedírsela a grupos de oficina.
        </p>
        {groups.length === 0 ? (
          <p className="muted small">
            Aún no hay grupos. Créalos en <Link to="/colaboradores/grupos">Colaboradores › Grupos</Link> (por ejemplo,
            "Terreno").
          </p>
        ) : (
          <ul className="group-pick-list">
            {sortGroups(groups).map((g) => (
              <li key={g.id}>
                <label className="group-pick">
                  <input
                    type="checkbox"
                    checked={picked.has(g.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(g.id);
                      else next.delete(g.id);
                      setPicked(next);
                      setStatus(null);
                    }}
                  />
                  <span className="read-name">{g.name}</span>
                  <span className="muted small group-pick-email">
                    {g.memberUids.length === 1 ? '1 persona' : `${g.memberUids.length} personas`}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {status ? (
        <p className={`banner ${status.ok ? 'ok' : 'error'}`} role={status.ok ? 'status' : 'alert'}>
          {status.text}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy || !dirty}>
          {busy ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>
    </form>
  );
}

export interface DayReportsProps {
  date: string;
  /** People asked for the report (members of the chosen groups), plus whoever sent one that day. */
  people: readonly WithId<UserProfile>[];
  reports: readonly WithId<DailyReport>[];
}

/** One day: each person with her report, or "Sin minuta". Senders first. */
export function DayReports({ people, reports }: DayReportsProps) {
  const byUid = new Map(reports.map((r) => [r.uid, r]));
  const rows = [...people].sort((a, b) => {
    const ra = byUid.get(a.id);
    const rb = byUid.get(b.id);
    if (!!ra !== !!rb) return ra ? -1 : 1;
    return nameOf(a).localeCompare(nameOf(b), 'es');
  });
  if (rows.length === 0) return <Empty title="Nadie envía minuta">Activa la minuta y marca personas como Terreno en Colaboradores, o elige un grupo.</Empty>;
  return (
    <ul className="list report-list">
      {rows.map((p) => {
        const r = byUid.get(p.id);
        return (
          <li key={p.id} className="list-item report-item">
            <div className="report-head">
              <span className="avatar small-avatar" aria-hidden="true">
                {initials(nameOf(p))}
              </span>
              <Link className="person-name" to={`/colaborador/${p.id}`}>
                {nameOf(p)}
              </Link>
              {r ? (
                <span className="chip ok">
                  Enviada {time(r.updatedAt)}
                  {r.source === 'audio' ? ' · por audio' : ''}
                </span>
              ) : (
                <span className="chip warn">Sin minuta</span>
              )}
            </div>
            {r ? (
              <div className="report-body">
                <p className="report-text">{r.text}</p>
                {r.transcript ? (
                  <details className="report-transcript">
                    <summary className="small">Ver transcripción del audio</summary>
                    <p className="muted small">{r.transcript}</p>
                  </details>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

interface Loaded {
  config: OrgConfig | null;
  groups: WithId<PersonGroup>[];
  users: WithId<UserProfile>[];
}

/** Minutas (spec 2026-11-13-minuta-diaria): settings and the reports of one day. */
export function DailyReportsPage() {
  const data = useData();
  const { uid, profile } = useAdmin();
  const today = zonedDate(Date.now());
  const [date, setDate] = useState(today);
  const load = useLoad<Loaded>(async () => {
    const [config, groups, users] = await Promise.all([data.getOrgConfig(), data.listGroups(), data.listUsers()]);
    return { config, groups, users };
  }, [data]);
  const day = useLoad(() => data.listDailyReports(date, date), [data, date]);

  const settings = readDailyReportSettings(load.data?.config ?? null);
  const field = (load.data?.users ?? []).filter((u) => isFieldWorker(u)).map((u) => u.id);
  const asked = new Set(settings.enabled ? [...field, ...membersOf(load.data?.groups ?? [], settings.groupIds)] : []);
  const senders = new Set((day.data ?? []).map((r) => r.uid));
  const people = (load.data?.users ?? []).filter(
    (u) => senders.has(u.id) || (asked.has(u.id) && u.status === 'active'),
  );

  return (
    <>
      <PageHeader title="Minutas" subtitle="Lo que cuentan del día las personas en terreno al cerrar su jornada" />
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
            <DailyReportsSettings
              enabled={settings.enabled}
              groupIds={settings.groupIds}
              groups={load.data.groups}
              onSave={async (on, groupIds) => {
                // The rest of config/org as saved: this page only changes the daily report.
                const full = {
                  ...orgConfigToForm(load.data?.config ?? null, ALLOWED_DOMAINS),
                  dailyReportEnabled: on,
                  dailyReportGroupIds: groupIds,
                };
                await data.saveOrgConfig(buildOrgConfig(full, uid, Date.now(), profile.email));
                load.reload();
              }}
            />
          </section>
          <section className="card" aria-labelledby="h-reports">
            <div className="card-head report-day">
              <h2 id="h-reports">Minutas del {dayLabel(date)}</h2>
              <div className="list-actions">
                <button type="button" className="btn small-btn" aria-label="Día anterior" onClick={() => setDate(addDays(date, -1))}>
                  ←
                </button>
                <input
                  type="date"
                  aria-label="Día"
                  value={date}
                  max={today}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                />
                <button
                  type="button"
                  className="btn small-btn"
                  aria-label="Día siguiente"
                  disabled={date >= today}
                  onClick={() => setDate(addDays(date, 1))}
                >
                  →
                </button>
              </div>
            </div>
            {day.error && day.data === undefined ? (
              <ErrorState error={day.error} onRetry={day.reload} />
            ) : day.data === undefined ? (
              <Loading />
            ) : (
              <>
                <p className="muted small report-count">
                  {senders.size} de {people.length} {people.length === 1 ? 'persona envió' : 'personas enviaron'} su minuta.
                </p>
                <DayReports date={date} people={people} reports={day.data} />
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
