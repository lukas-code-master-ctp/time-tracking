import { useState } from 'react';
import { formatDuration } from '@timetracking/shared';
import { ACTIVITY_LEVELS, type Timeline as TimelineData, type TimelineBlock } from '../lib/timeline';

interface Props {
  timeline: TimelineData;
  /** Opens a screenshot of the block (lightbox). */
  onOpenScreenshot?(id: string): void;
}

/** Percentage text of a block with data: "90 % de actividad", or "—" when it was all a meeting. */
function percentText(b: TimelineBlock): string {
  return b.percent === null ? 'sin % de actividad (todo en reunión)' : `${b.percent} % de actividad`;
}

/** CSS classes of a cell: meeting color for mostly-meeting blocks, activity level otherwise. */
export function cellClass(b: TimelineBlock): string {
  const color = b.mostlyMeeting ? 'lvl-meeting' : `lvl-${b.level}`;
  return `cell ${color}${b.meetingSeconds > 0 ? ' has-meeting' : ''}${b.screenshots.length > 0 ? ' has-shot' : ''}`;
}

function describe(b: TimelineBlock): string {
  if (b.trackedSeconds === 0) {
    return `${b.rangeLabel}: sin datos${b.screenshots.length > 0 ? ', con captura' : ''}`;
  }
  const parts = [`${b.rangeLabel}: ${percentText(b)}`, `medido ${formatDuration(b.trackedSeconds)}`];
  if (b.meetingSeconds > 0) parts.push(`en reunión ${formatDuration(b.meetingSeconds)}`);
  if (b.outsideChromeSeconds > 0) parts.push(`fuera de Chrome ${formatDuration(b.outsideChromeSeconds)}`);
  if (b.topDomains.length > 0) parts.push(`sitios: ${b.topDomains.map((d) => d.domain).join(', ')}`);
  if (b.screenshots.length > 0) parts.push('con captura');
  return parts.join(', ');
}

export function Timeline({ timeline, onOpenScreenshot }: Props) {
  const [active, setActive] = useState<TimelineBlock | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const shown = active ?? timeline.rows.flatMap((r) => r.blocks).find((b) => b.slotStart === pinned) ?? null;

  return (
    <div className="timeline">
      <div className="timeline-grid" role="list" aria-label="Bloques de 10 minutos del día" onMouseLeave={() => setActive(null)}>
        {timeline.rows.map((row) => (
          <div className="timeline-row" role="listitem" key={`${row.hourLabel}-${row.blocks[0]?.slotStart ?? ''}`}>
            <span className="timeline-hour">{row.hourLabel}</span>
            <div className="timeline-cells">
              {row.blocks.map((b) => (
                <button
                  key={b.slotStart}
                  type="button"
                  className={`${cellClass(b)}${shown?.slotStart === b.slotStart ? ' selected' : ''}`}
                  aria-label={describe(b)}
                  aria-pressed={pinned === b.slotStart}
                  data-testid="timeline-cell"
                  onMouseEnter={() => setActive(b)}
                  onFocus={() => setActive(b)}
                  onBlur={() => setActive(null)}
                  onClick={() => setPinned((p) => (p === b.slotStart ? null : b.slotStart))}
                >
                  {b.percent !== null ? (
                    <span className="cell-pct">{b.percent}</span>
                  ) : b.trackedSeconds > 0 ? (
                    <span className="cell-pct" aria-hidden="true">
                      —
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="timeline-detail" aria-live="polite" data-testid="timeline-detail">
        {shown ? (
          <BlockDetail block={shown} onOpenScreenshot={onOpenScreenshot} />
        ) : (
          <p className="muted small">Pasa el cursor o toca un bloque para ver su detalle.</p>
        )}
      </div>

      <ul className="legend" aria-label="Leyenda">
        {ACTIVITY_LEVELS.map((l) => (
          <li key={l.level}>
            <span className={`swatch lvl-${l.level}`} aria-hidden="true" />
            {l.label}
          </li>
        ))}
        <li>
          <span className="swatch lvl-meeting" aria-hidden="true" />
          En reunión (la mitad del bloque o más)
        </li>
        <li>
          <span className="swatch lvl-mid has-meeting" aria-hidden="true" />
          Con tiempo en reunión
        </li>
        <li>
          <span className="swatch lvl-none" aria-hidden="true" />
          Sin datos
        </li>
        <li>
          <span className="swatch lvl-none has-shot" aria-hidden="true" />
          Con captura
        </li>
      </ul>
    </div>
  );
}

function BlockDetail({ block, onOpenScreenshot }: { block: TimelineBlock; onOpenScreenshot?: (id: string) => void }) {
  return (
    <div className="block-detail">
      <p className="block-title">
        <span className="strong">{block.rangeLabel}</span>
        {block.trackedSeconds === 0 ? (
          <span className="chip muted-chip">Sin datos</span>
        ) : block.percent === null ? (
          <span className="chip muted-chip" title="Todo el tiempo medido fue en reunión: no hay % de actividad">
            Actividad: —
          </span>
        ) : (
          <span className={`chip lvl-chip lvl-${block.level}`}>{block.percent} % de actividad</span>
        )}
        {block.mostlyMeeting ? <span className="chip lvl-chip lvl-meeting">En reunión</span> : null}
      </p>
      {block.trackedSeconds > 0 ? (
        <dl className="block-facts">
          <div>
            <dt>Medido</dt>
            <dd>{formatDuration(block.trackedSeconds)}</dd>
          </div>
          <div>
            <dt>Con actividad</dt>
            <dd>{formatDuration(block.activeSeconds)}</dd>
          </div>
          {block.meetingSeconds > 0 ? (
            <div>
              <dt>En reunión</dt>
              <dd>{formatDuration(block.meetingSeconds)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Fuera de Chrome</dt>
            <dd>{formatDuration(block.outsideChromeSeconds)}</dd>
          </div>
        </dl>
      ) : null}
      {block.topDomains.length > 0 ? (
        <p className="small">
          <span className="muted">Sitios principales: </span>
          {block.topDomains.map((d) => `${d.domain} (${formatDuration(d.seconds)})`).join(' · ')}
        </p>
      ) : null}
      {block.screenshots.length > 0 && onOpenScreenshot ? (
        <button type="button" className="link" onClick={() => onOpenScreenshot(block.screenshots[0]!.id)}>
          Ver captura de este bloque
        </button>
      ) : null}
    </div>
  );
}
