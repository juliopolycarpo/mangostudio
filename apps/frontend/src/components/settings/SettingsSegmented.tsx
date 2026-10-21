import { cn } from '@/lib/utils';

interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface SettingsSegmentedProps<T extends string> {
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Names the group; the options alone do not say what they choose between. */
  readonly ariaLabel: string;
  /**
   * `buttons` (default) is a set of pressed/unpressed buttons for choices that
   * apply at once. `radio` is a native radio group for choices that belong to a
   * form-like record (the rule file cards), where the platform's arrow-key
   * behaviour is wanted.
   */
  readonly kind?: 'buttons' | 'radio';
  /** Unique within the page; names the radio inputs so each group is its own. */
  readonly name?: string;
}

const SEGMENT =
  'inline-flex h-8 cursor-pointer items-center justify-center rounded-sm border px-3 text-sm font-medium transition-colors';
/** The selected segment: a neutral fill and a firmer border, with the accent as a 2px bar on its bottom edge, as under the current tab. */
const SEGMENT_ON =
  'relative border-stroke-strong bg-fill-selected text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent';
const SEGMENT_OFF = 'border-stroke bg-control text-fg-muted hover:bg-control-hover hover:text-fg';

/**
 * A short, mutually exclusive choice drawn as a row of segments. The selected
 * one is a neutral fill with a firmer border and a 2px accent bar under it, so
 * the accent still marks the current item but never reads as a second primary
 * button next to Save; the rest are quiet, `control` segments. The bar, not a
 * check, carries the colour: it does not change the segment's width when the
 * choice moves, and the fill alone would not survive a grayscale screen. For
 * two to four options; a longer list belongs in a `Select`.
 *
 * // Usage: <SettingsSegmented ariaLabel={s.label} value={theme} options={options} onChange={setTheme} />
 */
export function SettingsSegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  kind = 'buttons',
  name,
}: SettingsSegmentedProps<T>) {
  if (kind === 'radio') {
    return (
      <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              SEGMENT,
              'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus',
              option.value === value ? SEGMENT_ON : SEGMENT_OFF
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    );
  }

  return (
    <fieldset aria-label={ariaLabel} className="flex min-w-0 flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(SEGMENT, option.value === value ? SEGMENT_ON : SEGMENT_OFF)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
