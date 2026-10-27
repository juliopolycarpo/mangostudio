import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type SettingsRowLayout = 'inline' | 'field' | 'stacked';

interface SettingsRowProps {
  /** The setting's name (`text-sm`, 500). Optional for a row that is only a control and its hint. */
  readonly label?: ReactNode;
  /** One sentence under the name (`text-xs`, `fg-muted`). */
  readonly hint?: ReactNode;
  /** Id of the control: the name becomes a `<label htmlFor>`. Omit when the control names itself (`aria-label`). */
  readonly htmlFor?: string;
  /**
   * `label` makes the whole row the label of the control it contains, so a click
   * anywhere on it toggles a lone checkbox. `div` (default) leaves the control alone.
   */
  readonly as?: 'div' | 'label';
  /**
   * Where the control sits.
   * - `inline` (default): name on the left, control on the right at its own width, at every
   *   breakpoint. A switch, a checkbox, a small button or number field.
   * - `field`: the same from `sm` up, with the control 16rem wide; below `sm` it drops under the
   *   name at full width. A `Select` or a text field.
   * - `stacked`: the control spans the row under the name. A slider, a textarea, a segmented
   *   control, a path with its buttons.
   */
  readonly layout?: SettingsRowLayout;
  /** Trailing content on the name's line: a live readout (`30s`) or a small action (Reset). */
  readonly aside?: ReactNode;
  readonly className?: string;
  /** The control. */
  readonly children?: ReactNode;
}

const LAYOUT: Record<SettingsRowLayout, { root: string; control: string }> = {
  inline: {
    root: 'flex items-center justify-between gap-4',
    // A flex box, not a text line: an inline-flex switch in a block wrapper sits on
    // a line-height strut and rides a few pixels above the row's centre.
    control: 'flex shrink-0 items-center',
  },
  field: {
    root: 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
    control: 'w-full sm:w-64 sm:shrink-0',
  },
  stacked: {
    root: 'flex flex-col gap-3',
    control: 'w-full',
  },
};

const LABEL = 'block text-sm font-medium text-fg';

/**
 * One setting: its name and hint on the left, its control on the right. The
 * row owns the padding (`px-4 py-3`) and nothing else — the stroke between
 * rows comes from the `SettingsSection` card that holds them, so a row also
 * works on its own.
 *
 * // Usage:
 * <SettingsRow label={s.languageLabel} hint={s.languageDescription} layout="field">
 *   <Select value={locale} options={locales} onChange={setLocale} ariaLabel={s.languageLabel} />
 * </SettingsRow>
 */
export function SettingsRow({
  label,
  hint,
  htmlFor,
  as: Root = 'div',
  layout = 'inline',
  aside,
  className,
  children,
}: SettingsRowProps) {
  const { root, control } = LAYOUT[layout];
  // A `<label>` inside the row-as-label would nest one label in another, and
  // a `<div>` inside a `<label>` is not phrasing content.
  const named = htmlFor && Root === 'div';
  const Wrap = Root === 'label' ? 'span' : 'div';

  const text =
    label || hint ? (
      <span className="block min-w-0 flex-1">
        {label ? (
          named ? (
            <label htmlFor={htmlFor} className={LABEL}>
              {label}
            </label>
          ) : (
            <span className={LABEL}>{label}</span>
          )
        ) : null}
        {hint ? (
          <span className={cn('block text-xs text-fg-muted', label && 'mt-0.5')}>{hint}</span>
        ) : null}
      </span>
    ) : null;

  const header = aside ? (
    <Wrap className="flex min-w-0 flex-1 items-start justify-between gap-4">
      {text}
      <Wrap className="shrink-0 text-sm text-fg">{aside}</Wrap>
    </Wrap>
  ) : (
    text
  );

  return (
    <Root className={cn('px-4 py-3', root, Root === 'label' && 'cursor-pointer', className)}>
      {header}
      {children ? <Wrap className={cn('block', control)}>{children}</Wrap> : null}
    </Root>
  );
}
