import type { ReactNode } from 'react';

interface LockedChipProps {
  /** The `key` half of the `key: value` chip. */
  readonly label: string;
  readonly value: string;
  /**
   * Why this cannot change, in a sentence. It is the hover explanation and also
   * follows the chip as screen-reader text, because a tooltip on a plain
   * element is not announced and is not there at all on touch.
   */
  readonly reason: string;
  /** Leads the chip, as a picker's glyph does. */
  readonly icon?: ReactNode;
  /** Between the icon and the key, for a status dot and the like. */
  readonly adornment?: ReactNode;
  /** Another element that describes this one, as it does for the picker it stands in for. */
  readonly describedBy?: string;
  readonly testId?: string;
  readonly dataState?: string;
}

/**
 * A `key: value` chip that states a fact instead of offering a choice.
 *
 * What a `ChipSelect` becomes once its answer is settled — the agent chip and
 * the environment chip, after a chat's first turn. The disabled select it
 * replaces dropped the whole chip to half opacity (the key to 2.3:1 against its
 * surface, the value to 3.3:1) and kept a chevron promising a menu that could
 * not open, for a fact (who is answering, where it runs) that is information
 * rather than a dead control. Without the chevron, with the key and value at
 * full strength, it reads the way the context ring and the usage chips beside it
 * do. The 50% rule is for a control that is merely off — loading, or failed —
 * and stays with the select.
 *
 * It carries no glyph of its own beyond the `icon` a caller passes: the lock
 * beside `mode:` means a permission level, and a second one here would mean
 * something else on the same line.
 *
 * The wrapper mirrors `ChipSelect`'s, so the `·` the composer's strip draws
 * after its children sits beside this chip exactly where it sits beside a
 * select.
 *
 * // Usage: <LockedChip label={s.agentLabel} value={agent.name} reason={s.agentLocked} />
 */
export function LockedChip({
  label,
  value,
  reason,
  icon,
  adornment,
  describedBy,
  testId,
  dataState,
}: LockedChipProps) {
  return (
    <span className="relative flex items-center" data-testid={testId} data-state={dataState}>
      <span
        className="composer-chip max-w-[13rem] cursor-default"
        title={reason}
        aria-describedby={describedBy}
      >
        {icon}
        {adornment}
        <span className="composer-chip-key text-fg-muted">{`${label}:`}</span>
        <span className="composer-chip-value">{value}</span>
        <span className="sr-only">{reason}</span>
      </span>
    </span>
  );
}
