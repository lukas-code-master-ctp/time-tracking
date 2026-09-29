import { useId, useState } from 'react';
import { MAX_CUSTOM_RANGE_DAYS, RANGE_PRESETS, addDays, daysBetween, formatShortDate, isValidDate, type DateRange, type RangePreset } from '../lib/dates';

interface Props {
  range: DateRange;
  onPreset(preset: RangePreset): void;
  onCustom(fromDate: string, toDate: string): void;
}

const SPAN = MAX_CUSTOM_RANGE_DAYS - 1;

export function RangePicker({ range, onPreset, onCustom }: Props) {
  const id = useId();
  // A date picked beyond the cap moves the other end so the range stays ≤ 93 days.
  const [adjusted, setAdjusted] = useState(false);
  const pickFrom = (from: string): void => {
    const tooLong = daysBetween(from, range.toDate) > SPAN;
    setAdjusted(tooLong);
    onCustom(from, tooLong ? addDays(from, SPAN) : range.toDate);
  };
  const pickTo = (to: string): void => {
    const tooLong = daysBetween(range.fromDate, to) > SPAN;
    setAdjusted(tooLong);
    onCustom(tooLong ? addDays(to, -SPAN) : range.fromDate, to);
  };
  const capped = range.clamped === true || adjusted;
  return (
    <div className="range-picker">
      <div className="segmented" role="group" aria-label="Periodo">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={range.preset === p.value ? 'active' : ''}
            aria-pressed={range.preset === p.value}
            onClick={() => onPreset(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {range.preset === 'custom' ? (
        <div className="custom-range">
          <label htmlFor={`${id}-from`}>
            Desde
            <input
              id={`${id}-from`}
              type="date"
              value={range.fromDate}
              max={range.toDate}
              aria-describedby={`${id}-cap`}
              onChange={(e) => {
                if (isValidDate(e.target.value)) pickFrom(e.target.value);
              }}
            />
          </label>
          <label htmlFor={`${id}-to`}>
            Hasta
            <input
              id={`${id}-to`}
              type="date"
              value={range.toDate}
              min={range.fromDate}
              aria-describedby={`${id}-cap`}
              onChange={(e) => {
                if (isValidDate(e.target.value)) pickTo(e.target.value);
              }}
            />
          </label>
          <p id={`${id}-cap`} className={capped ? 'banner warn small range-cap' : 'muted small range-cap'} role="status">
            {capped
              ? `El rango personalizado puede tener como máximo ${MAX_CUSTOM_RANGE_DAYS} días: se ajustó a ${formatShortDate(range.fromDate)} – ${formatShortDate(range.toDate)}.`
              : `Máximo ${MAX_CUSTOM_RANGE_DAYS} días.`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
