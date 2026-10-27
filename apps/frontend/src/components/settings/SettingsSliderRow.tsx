import { type CSSProperties, type ReactNode, useState } from 'react';

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
  /**
   * Adds a number field beside the track for exact entry. A keystroke commits
   * only a value inside the range; anything else (empty, `5` on the way to `75`)
   * stays a draft in the field until blur, which clamps it and commits.
   */
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
 * How far along the track `value` sits, 0–1, for the accent fill `.range-field`
 * paints over the travelled part. An empty range reads as the start.
 */
function progress(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return (clamp(value, min, max) - min) / (max - min);
}

/**
 * A `SettingsRow` whose control is a range slider, optionally paired with a
 * number field. The track is `.range-field` around a `.range-input` (see the
 * stylesheet): the wrapper draws the pill and the accent over its travelled part.
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
        <div
          className="range-field min-w-0 flex-1"
          style={{ '--range-progress': progress(value, min, max) } as CSSProperties}
        >
          <input
            id={id}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onChange(Number(event.target.value))}
            disabled={disabled}
            className="range-input"
          />
        </div>
        {withNumberInput ? (
          <NumberField
            label={label}
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={onChange}
            disabled={disabled}
          />
        ) : null}
      </div>
    </SettingsRow>
  );
}

interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
}

/**
 * The exact-entry twin of the track. Settings auto-save, so committing every
 * keystroke would persist `0` for an emptied field or `5` while typing `75`; the
 * text being typed lives in `draft` until it parses into the range or the field
 * loses focus.
 */
function NumberField({ label, value, min, max, step, onChange, disabled }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? value}
      onChange={(event) => {
        setDraft(event.target.value);
        const typed = event.target.valueAsNumber;
        if (!Number.isNaN(typed) && typed >= min && typed <= max) onChange(typed);
      }}
      onBlur={(event) => {
        setDraft(null);
        const next = clamp(event.target.valueAsNumber, min, max);
        if (next !== value) onChange(next);
      }}
      disabled={disabled}
      aria-label={label}
      className="w-32 text-center"
    />
  );
}
