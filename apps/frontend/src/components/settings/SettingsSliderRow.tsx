import type { ReactNode } from 'react';
import { Input } from '@/components/ui/Input';
import { SettingsRow } from './SettingsRow';

interface SettingsSliderRowProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** The live value in words — `60% of context`, `30s`. Sits on the name's line. */
  readonly readout?: ReactNode;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  /** Adds a number field beside the track for exact entry. */
  readonly withNumberInput?: boolean;
  /**
   * Commit the number field again on blur, which clamps what was typed. Turn it
   * off where an unset value is shown as its default: tabbing through the field
   * would otherwise pin that default as an explicit override.
   */
  readonly commitOnBlur?: boolean;
}

/**
 * A `SettingsRow` whose control is a range slider, optionally paired with a
 * number field. The track is the `.range-input` class from the stylesheet.
 *
 * // Usage: <SettingsSliderRow id="timeout" label={s.timeoutLabel} readout="30s" value={30} min={5} max={60} onChange={setTimeout} />
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
  commitOnBlur = true,
}: SettingsSliderRowProps) {
  return (
    <SettingsRow label={label} hint={hint} htmlFor={id} layout="stacked" aside={readout}>
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
            onBlur={commitOnBlur ? (event) => onChange(Number(event.target.value)) : undefined}
            disabled={disabled}
            aria-label={label}
            className="w-20 text-center"
          />
        ) : null}
      </div>
    </SettingsRow>
  );
}
