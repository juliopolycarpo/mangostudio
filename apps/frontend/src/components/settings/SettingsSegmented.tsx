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
const SEGMENT_ON = 'border-transparent bg-accent text-on-accent hover:bg-accent-hover';
const SEGMENT_OFF = 'border-stroke bg-control text-fg hover:bg-control-hover';

/**
 * A short, mutually exclusive choice drawn as a row of segments: the selected
 * one carries the accent, the rest are secondary buttons. For two to four
 * options; a longer list belongs in a `Select`.
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
