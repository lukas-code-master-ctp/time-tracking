import type { ReactNode } from 'react';
import { formatDuration } from '@timetracking/shared';
import { errorMessage } from '../lib/messages';
import { activityLevel } from '../lib/timeline';

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state empty">
      <p className="state-title">{title}</p>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <p className="state-title">No se pudieron cargar los datos</p>
      <p className="muted">{errorMessage(error)}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Reintentar
        </button>
      ) : null}
    </div>
  );
}

/**
 * Percentage with a small bar colored by level (baja / media / alta).
 * `percent` null: "Sin datos", or "—" when time was `measured` but all of it
 * was a meeting (meeting time is left out of the percentage).
 */
export function ActivityMeter({ percent, measured = false }: { percent: number | null; measured?: boolean }) {
  if (percent === null) {
    return measured ? (
      <span className="muted" title="Sin % de actividad: todo el tiempo medido fue en reunión">
        —<span className="sr-only"> (sin % de actividad: todo el tiempo medido fue en reunión)</span>
      </span>
    ) : (
      <span className="muted">Sin datos</span>
    );
  }
  const level = activityLevel(percent);
  return (
    <span className="meter" title={`Actividad ${percent} %`}>
      <span className="meter-value">{percent} %</span>
      <span className="meter-track" aria-hidden="true">
        <span className={`meter-fill lvl-${level}`} style={{ width: `${Math.max(2, percent)}%` }} />
      </span>
    </span>
  );
}

export interface BarItem {
  key: string;
  label: string;
  seconds: number;
  title?: string;
}

/** Horizontal bars proportional to the largest value. */
export function BarList({ items, emptyText }: { items: readonly BarItem[]; emptyText: string }) {
  if (items.length === 0) return <p className="muted small">{emptyText}</p>;
  const max = Math.max(...items.map((i) => i.seconds), 1);
  return (
    <ol className="barlist">
      {items.map((item) => (
        <li key={item.key}>
          <div className="barlist-row">
            <span className="barlist-label" title={item.title ?? item.label}>
              {item.label}
            </span>
            <span className="barlist-value">{formatDuration(item.seconds)}</span>
          </div>
          <span className="barlist-track" aria-hidden="true">
            <span className="barlist-fill" style={{ width: `${Math.max(2, (item.seconds / max) * 100)}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-heading">
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
