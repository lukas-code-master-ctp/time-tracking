import { useId } from 'react';
import { RANGE_PRESETS, isValidDate, type DateRange, type RangePreset } from '../lib/dates';

interface Props {
  range: DateRange;
  onPreset(preset: RangePreset): void;
  onCustom(fromDate: string, toDate: string): void;
}

export function RangePicker({ range, onPreset, onCustom }: Props) {
  const id = useId();
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
              onChange={(e) => {
                if (isValidDate(e.target.value)) onCustom(e.target.value, range.toDate);
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
              onChange={(e) => {
                if (isValidDate(e.target.value)) onCustom(range.fromDate, e.target.value);
              }}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
