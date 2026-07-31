/**
 * The shell every tool card shares.
 *
 * A tool reads the same wherever it appears: identity first — avatar, effective
 * name, the menu that renames it — then whatever that surface knows about it,
 * then the actions it offers. Cards differ in body, never in anatomy, so a card
 * is this component plus its content and the overview can render a denser one
 * without inventing a second look.
 */

import type { ToolIdentityKind } from '@mangostudio/shared/tool-identity';
import type { ReactNode } from 'react';
import type { ToolAvatarSize } from '@/components/ui/ToolAvatar';
import { ToolIdentityHeader } from '../identity/ToolIdentityHeader';

/**
 * The card surface itself. Exported so panels that are card-shaped without
 * being a tool — the health rollup, the library snapshot — cannot drift away
 * from the cards they sit beside.
 */
export const TOOL_CARD_SURFACE =
  'rounded-2xl border border-outline-variant/15 bg-surface-container-high';

const DENSITY_CLASS = {
  comfortable: 'space-y-4 p-5 sm:p-6',
  compact: 'space-y-3 p-4',
} as const;

interface ToolCardProps {
  readonly kind: ToolIdentityKind;
  /** Wire id — a runtime id, agent target id, or version manager id. */
  readonly id: string;
  readonly fallbackName?: string;
  readonly avatarSize?: ToolAvatarSize;
  readonly subtitle?: ReactNode;
  /** Status affordances that sit opposite the name: health badge, probe. */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  /** The row of actions that closes the card, so every card ends the same way. */
  readonly footer?: ReactNode;
  readonly density?: keyof typeof DENSITY_CLASS;
  readonly testId: string;
  /**
   * The id hook this card is found by (`data-target-id`, `data-runtime-id`).
   * Tests key on these, so they are passed through rather than derived.
   */
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>>;
  readonly className?: string;
}

export function ToolCard({
  kind,
  id,
  fallbackName,
  avatarSize,
  subtitle,
  actions,
  children,
  footer,
  density = 'comfortable',
  testId,
  dataAttributes,
  className = '',
}: ToolCardProps) {
  return (
    <article
      className={`${TOOL_CARD_SURFACE} ${DENSITY_CLASS[density]} ${className}`}
      data-testid={testId}
      {...dataAttributes}
    >
      <ToolIdentityHeader
        kind={kind}
        id={id}
        fallbackName={fallbackName}
        avatarSize={avatarSize}
        subtitle={subtitle}
        actions={actions}
      />

      {children}

      {footer ? <footer className="flex flex-wrap items-center gap-2">{footer}</footer> : null}
    </article>
  );
}

/** The small-caps label that titles a section inside a card. */
export function CardSectionLabel({
  children,
  className = '',
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <p
      className={`font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 ${className}`}
    >
      {children}
    </p>
  );
}
