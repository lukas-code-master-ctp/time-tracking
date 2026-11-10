import { useMemo, useState } from 'react';
import {
  ATTENDANCE_MODES,
  ATTENDANCE_MODE_LABELS,
  KIOSK_NAME_MAX,
  allowsKiosk,
  attendanceDays,
  formatDuration,
  formatRut,
  normalizeRut,
  type AttendanceMode,
  type AttendanceSettings,
  type Kiosk,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { ConfirmDialog } from '../components/Modal';
import { PeopleTabs } from '../components/PeopleTabs';
import { RangePicker } from '../components/RangePicker';
import { initials } from '../components/TeamTable';
import { Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { useAdmin, useData } from '../data/context';
import {
  SOURCE_LABEL,
  attendanceCsv,
  attendanceFormError,
  buildAttendanceSettings,
  exitLabel,
  kioskIdOf,
  kioskUrl,
  newKioskToken,
  type AttendanceForm,
} from '../lib/attendance';
import { describeRange, formatRelativeDateTime, formatShortDate, formatTime, presetRange, type DateRange } from '../lib/dates';
import { copyText, downloadText } from '../lib/download';
import { errorMessage } from '../lib/messages';
import { useLoad } from '../lib/useLoad';

const byName = (a: WithId<UserProfile>, b: WithId<UserProfile>): number =>
  (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) ||
  (a.displayName || a.email).localeCompare(b.displayName || b.email, 'es');

/**
 * Colaboradores › Marcaciones (spec 2026-11-10-marcaciones): entries and
 * exits of each person (from the extension or the kiosk), how each one
 * marks, and the kiosks (tablets at the entrance) allowed to mark.
 */
export function AttendancePage() {
  const data = useData();
  const [range, setRange] = useState<DateRange>(() => presetRange('thisWeek', Date.now()));
  const [person, setPerson] = useState('');

  const people = useLoad(async () => {
    const [users, settings] = await Promise.all([data.listUsers(), data.listAttendanceSettings()]);
    return { users: [...users].sort(byName), settings: new Map(settings.map(({ id, ...s }) => [id, s])) };
  }, [data]);
  const marks = useLoad(async () => {
    const sessions = await data.listSessions(range);
    return { sessions, now: Date.now() };
  }, [data, range.from, range.to]);

  const rows = useMemo(() => {
    if (!marks.data) return [];
    return attendanceDays(marks.data.sessions, marks.data.now).filter(
      (r) => r.date >= range.fromDate && r.date <= range.toDate && (!person || r.uid === person),
    );
  }, [marks.data, range.fromDate, range.toDate, person]);
  const users = new Map((people.data?.users ?? []).map((u) => [u.id, u]));

  const download = (): void => {
    if (!people.data) return;
    downloadText(
      `marcaciones-${range.fromDate}-a-${range.toDate}.csv`,
      attendanceCsv(rows, users, people.data.settings),
      'text/csv;charset=utf-8',
    );
  };

  return (
    <>
      <PageHeader
        title="Colaboradores"
        subtitle="Entradas y salidas de cada persona, marcadas desde la extensión o desde el tótem de la oficina con su RUT."
      />
      <PeopleTabs />

      <section className="card" aria-labelledby="marks-title">
        <div className="card-head">
          <h2 id="marks-title">Marcaciones</h2>
          <span className="muted small">{describeRange(range)}</span>
        </div>
        <div className="toolbar">
          <RangePicker
            range={range}
            onPreset={(p) => setRange(presetRange(p, Date.now(), undefined, { fromDate: range.fromDate, toDate: range.toDate }))}
            onCustom={(fromDate, toDate) => setRange(presetRange('custom', Date.now(), undefined, { fromDate, toDate }))}
          />
          <div className="toolbar-end">
            <label className="sr-only" htmlFor="marks-person">
              Persona
            </label>
            <select id="marks-person" value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Todas las personas</option>
              {(people.data?.users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName || u.email}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={download} disabled={rows.length === 0 || !people.data}>
              Descargar CSV
            </button>
          </div>
        </div>
        {marks.error && !marks.data ? (
          <ErrorState error={marks.error} onRetry={marks.reload} />
        ) : !marks.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="muted">No hay marcaciones en este periodo.</p>
        ) : (
          <div className="table-wrap" tabIndex={0} aria-label="Marcaciones (desplázate para ver todas las columnas)">
            <table className="table compact attendance-table">
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Persona</th>
                  <th scope="col">Entrada</th>
                  <th scope="col">Salida</th>
                  <th scope="col" className="num">
                    En jornada
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const u = users.get(r.uid);
                  const name = u?.displayName || u?.email || 'Persona eliminada';
                  return (
                    <tr key={`${r.uid}-${r.date}`}>
                      <td className="nowrap">{formatShortDate(r.date)}</td>
                      <td>
                        <span className="person-name">{name}</span>
                      </td>
                      <td className="nowrap">
                        {formatTime(r.firstIn)} <span className={`chip${r.inSource === 'kiosk' ? ' accent-chip' : ''}`}>{SOURCE_LABEL[r.inSource]}</span>
                      </td>
                      <td className="nowrap">
                        {r.open ? (
                          <span className="chip ok">En curso</span>
                        ) : (
                          <>
                            {exitLabel(r)}{' '}
                            {r.outSource === 'auto' ? (
                              <span className="chip warn">{r.workedSeconds === 0 ? 'No marcó salida' : 'Cierre automático'}</span>
                            ) : r.outSource ? (
                              <span className={`chip${r.outSource === 'kiosk' ? ' accent-chip' : ''}`}>{SOURCE_LABEL[r.outSource]}</span>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="num">{formatDuration(r.workedSeconds)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted small footnote">
        Una fila por persona y día: la primera entrada y la última salida. “En jornada” suma el tiempo con la jornada abierta (con la
        extensión, se descuentan los ratos con el computador suspendido). Si alguien olvida marcar la salida en el tótem, la jornada se
        cierra sola a la hora de salida de su horario (sin horario, queda en 0 y aparece “No marcó salida”).
      </p>

      <section className="card flush" aria-labelledby="modes-title">
        <div className="card-head padded">
          <h2 id="modes-title">Cómo marca cada persona</h2>
          <span className="muted small">Extensión, tótem o ambas</span>
        </div>
        {people.error && !people.data ? (
          <ErrorState error={people.error} onRetry={people.reload} />
        ) : !people.data ? (
          <Loading />
        ) : people.data.users.length === 0 ? (
          <Empty title="Aún no hay colaboradores" />
        ) : (
          <ul className="list">
            {people.data.users.map((u) => (
              <ModeRow
                key={u.id}
                user={u}
                current={people.data!.settings.get(u.id) ?? null}
                others={
                  new Set(
                    [...people.data!.settings.entries()].filter(([id, s]) => id !== u.id && s.rut).map(([, s]) => s.rut!),
                  )
                }
                onSaved={people.reload}
              />
            ))}
          </ul>
        )}
      </section>

      <Kiosks />
    </>
  );
}

function ModeRow({
  user,
  current,
  others,
  onSaved,
}: {
  user: WithId<UserProfile>;
  current: AttendanceSettings | null;
  others: ReadonlySet<string>;
  onSaved: () => void;
}) {
  const data = useData();
  const { uid: me } = useAdmin();
  const saved: AttendanceForm = { rut: current?.rut ? formatRut(current.rut) : '', mode: current?.mode ?? 'extension' };
  const [form, setForm] = useState<AttendanceForm>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const name = user.displayName || user.email;
  const dirty = form.mode !== saved.mode || (normalizeRut(form.rut) ?? form.rut.trim()) !== (current?.rut ?? '');
  const id = `att-${user.id}`;

  const set = (patch: Partial<AttendanceForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setOk(false);
    setError(null);
  };

  const save = async (): Promise<void> => {
    const invalid = attendanceFormError(form, others);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = buildAttendanceSettings(form, me, Date.now());
      await data.saveAttendanceSettings(user.id, next);
      setForm({ rut: next.rut ? formatRut(next.rut) : '', mode: next.mode });
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
        className="attendance-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="celebration-hire">
          <label htmlFor={`${id}-rut`}>RUT</label>
          <input
            id={`${id}-rut`}
            type="text"
            className="rut-input"
            inputMode="text"
            autoComplete="off"
            placeholder="12.345.678-5"
            value={form.rut}
            maxLength={12}
            onChange={(e) => set({ rut: e.target.value })}
            onBlur={() => {
              const n = normalizeRut(form.rut);
              if (n) set({ rut: formatRut(n) });
            }}
            aria-label={`RUT de ${name}`}
          />
        </div>
        <div className="celebration-hire">
          <label htmlFor={`${id}-mode`}>Marca en</label>
          <select
            id={`${id}-mode`}
            value={form.mode}
            onChange={(e) => set({ mode: e.target.value as AttendanceMode })}
            aria-label={`Cómo marca ${name}`}
          >
            {ATTENDANCE_MODES.map((m) => (
              <option key={m} value={m}>
                {ATTENDANCE_MODE_LABELS[m]}
              </option>
            ))}
          </select>
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
      ) : allowsKiosk(form.mode) && !form.rut.trim() ? (
        <p className="muted small celebration-error">Agrega su RUT para que pueda marcar en el tótem.</p>
      ) : null}
    </li>
  );
}

function Kiosks() {
  const data = useData();
  const { uid: me } = useAdmin();
  const load = useLoad(() => data.listKiosks(), [data]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoke, setRevoke] = useState<WithId<Kiosk> | null>(null);

  const create = async (): Promise<void> => {
    const clean = name.trim();
    if (!clean) {
      setError('Ponle un nombre al tótem (por ejemplo, “Recepción”).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = newKioskToken();
      await data.createKiosk(await kioskIdOf(token), { name: clean, createdAt: Date.now(), createdBy: me, revokedAt: null });
      setCreated({ name: clean, url: kioskUrl(window.location.origin, token) });
      setCopied(false);
      setName('');
      load.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmRevoke = async (): Promise<void> => {
    if (!revoke) return;
    setBusy(true);
    setError(null);
    try {
      await data.revokeKiosk(revoke.id, Date.now());
      setRevoke(null);
      load.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const kiosks = [...(load.data ?? [])].sort((a, b) => (a.revokedAt === null ? 0 : 1) - (b.revokedAt === null ? 0 : 1) || b.createdAt - a.createdAt);
  const now = Date.now();

  return (
    <section className="card" aria-labelledby="kiosks-title">
      <div className="card-head">
        <h2 id="kiosks-title">Tótems de marcación</h2>
      </div>
      <p className="muted small">
        Un tótem es una tablet o computador en la entrada de la oficina con la página de marcación abierta. Al crearlo obtienes un enlace:
        ábrelo una vez en ese dispositivo y quedará activado. Cada persona marca su entrada y su salida con su RUT.
      </p>
      <form
        className="kiosk-create"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label htmlFor="kiosk-name">Nombre del tótem</label>
        <input
          id="kiosk-name"
          type="text"
          value={name}
          maxLength={KIOSK_NAME_MAX}
          placeholder="Recepción"
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Creando…' : 'Crear tótem'}
        </button>
      </form>
      {error && !revoke ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {created ? (
        <div className="banner ok kiosk-link" role="status">
          <p>
            <strong>Tótem “{created.name}” creado.</strong> Abre este enlace en el dispositivo de la entrada. Solo se muestra ahora: si lo
            pierdes, crea otro tótem.
          </p>
          <div className="kiosk-link-row">
            <code>{created.url}</code>
            <button
              type="button"
              className="btn small-btn"
              onClick={() => void copyText(created.url).then((done) => setCopied(done))}
            >
              {copied ? 'Copiado' : 'Copiar enlace'}
            </button>
          </div>
        </div>
      ) : null}
      {load.error && !load.data ? (
        <ErrorState error={load.error} onRetry={load.reload} />
      ) : !load.data ? (
        <Loading />
      ) : kiosks.length === 0 ? (
        <p className="muted small">Aún no hay tótems.</p>
      ) : (
        <ul className="list kiosk-list">
          {kiosks.map((k) => (
            <li key={k.id} className={`list-item${k.revokedAt !== null ? ' dimmed' : ''}`}>
              <span className="person-text">
                <span className="person-name">{k.name}</span>
                <span className="muted small">
                  Creado {formatRelativeDateTime(k.createdAt, now)}
                  {k.lastUsedAt ? ` · última marca ${formatRelativeDateTime(k.lastUsedAt, now)}` : ' · sin marcas aún'}
                </span>
              </span>
              <div className="list-actions">
                {k.revokedAt === null ? (
                  <>
                    <span className="chip ok">Activo</span>
                    <button type="button" className="btn small-btn danger-outline" onClick={() => setRevoke(k)}>
                      Desactivar
                    </button>
                  </>
                ) : (
                  <span className="chip">Desactivado</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {revoke ? (
        <ConfirmDialog
          title="Desactivar tótem"
          message={<p>“{revoke.name}” ya no podrá marcar entradas ni salidas. Para volver a usar ese dispositivo, crea un tótem nuevo.</p>}
          confirmLabel="Desactivar"
          danger
          busy={busy}
          error={error}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => {
            setRevoke(null);
            setError(null);
          }}
        />
      ) : null}
    </section>
  );
}
