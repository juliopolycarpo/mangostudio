import type { ReactNode } from 'react';
import { Input } from '@/components/ui/Input';
import { SettingsRow } from './SettingsRow';

interface SettingsSliderRowProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /**
   * The live value in words — `30s`, `120 characters`. Sits on the name's line,
   * muted and tabular so the digits do not jitter while dragging. Leave it out
   * beside a number field, which already shows the value.
   */
  readonly readout?: ReactNode;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  /** Adds a number field beside the track for exact entry. Committed again on blur, which clamps what was typed. */
  readonly withNumberInput?: boolean;
}

/**
 * Keeps a typed number inside the track. An emptied or unparsable field reads as
 * `NaN` and falls back to the minimum rather than committing `0`.
 */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * A `SettingsRow` whose control is a range slider, optionally paired with a
 * number field. The track is the `.range-input` class from the stylesheet.
 *
 * // Usage: <SettingsSliderRow id="timeout" label={s.timeoutLabel} readout="30s" value={30} min={5} max={60} onChange={setTimeout} />
 *
 * A range with hundreds of steps cannot be set by dragging; that is a plain
 * number field in an inline `SettingsRow`, not a slider with a number beside it.
 */
export function SettingsSliderRow({
  id,
  label,
  hint,
  readout,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
  withNumberInput = false,
}: SettingsSliderRowProps) {
  return (
    <SettingsRow
      label={label}
      hint={hint}
      htmlFor={id}
      layout="stacked"
      aside={readout ? <span className="tabular-nums text-fg-muted">{readout}</span> : undefined}
    >
      <div className="flex items-center gap-4">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={disabled}
          className="range-input min-w-0 flex-1"
        />
        {withNumberInput ? (
          <Input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onChange(Number(event.target.value))}
            onBlur={(event) => onChange(clamp(event.target.valueAsNumber, min, max))}
            disabled={disabled}
            aria-label={label}
            className="w-32 text-center"
          />
        ) : null}
      </div>
    </SettingsRow>
  );
}
