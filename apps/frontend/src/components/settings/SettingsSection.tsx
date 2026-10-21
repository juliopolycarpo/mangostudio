import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/utils';

interface SettingsSectionHeaderProps {
  readonly title: string;
  readonly description?: string;
  /** A control that belongs to the heading rather than to a row (Add, Refresh). */
  readonly action?: ReactNode;
}

/**
 * The heading of a group of settings: a 16px/600 title, an optional description
 * in `fg-muted`, and an action on the right. Used by `SettingsSection`; on its
 * own it heads a list of cards that are not one card (servers, keys).
 *
 * // Usage: <SettingsSectionHeader title={s.keysTitle} action={<Button size="sm">…</Button>} />
 */
function SettingsSectionHeader({ title, description, action }: SettingsSectionHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h3 className="text-base font-semibold text-fg">{title}</h3>
        {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

interface SettingsSectionProps {
  /** Omit for a group that needs no heading — the first card under the page title. */
  readonly title?: string;
  readonly description?: string;
  readonly action?: ReactNode;
  /** A `<Callout>` shown between the heading and the card. */
  readonly notice?: ReactNode;
  /**
   * `false` (default): the children are `SettingsRow`s, divided by hairlines. `true`: the
   * children are free-form content in a padded body (a preview, a grid of tiles, a list).
   */
  readonly padded?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * A titled group of settings in one flat card. Rows inside it are divided by a
 * `stroke` line; the card has no shadow. Sections stack at `space-y-8` inside
 * `SettingsPage`.
 *
 * // Usage:
 * <SettingsSection title={s.title} description={s.description}>
 *   <SettingToggle label={s.enableLabel} description={s.enableHint} checked={on} onChange={setOn} />
 *   <SettingsRow label={s.modelLabel} layout="field">…</SettingsRow>
 * </SettingsSection>
 */
export function SettingsSection({
  title,
  description,
  action,
  notice,
  padded = false,
  className,
  children,
}: SettingsSectionProps) {
  return (
    <section className={cn('space-y-3', className)}>
      {title ? (
        <SettingsSectionHeader title={title} description={description} action={action} />
      ) : null}
      {notice}
      <Card padded={false} className={padded ? 'space-y-4 p-4' : 'divide-y divide-stroke'}>
        {children}
      </Card>
    </section>
  );
}
