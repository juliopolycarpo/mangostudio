/**
 * The identity half of a tool card: avatar, effective name, and the menu that
 * renames or resets it.
 *
 * Cards share this rather than each assembling an avatar and a menu, so a tool
 * looks and behaves the same wherever it appears.
 */

import type { ToolIdentityKind } from '@mangostudio/shared/tool-identity';
import type { ReactNode } from 'react';
import { ToolAvatar, type ToolAvatarSize } from '@/components/ui/ToolAvatar';
import { useI18n } from '@/hooks/use-i18n';
import { displayName } from '../format';
import { ToolIdentityMenu } from './ToolIdentityMenu';
import { useToolIdentities } from './use-tool-identities';

interface ToolIdentityHeaderProps {
  readonly kind: ToolIdentityKind;
  /** Wire id — a runtime id, agent target id, version manager id, or MCP slug. */
  readonly id: string;
  /** Default name for subjects the i18n dictionary does not know (MCP servers). */
  readonly fallbackName?: string;
  readonly avatarSize?: ToolAvatarSize;
  readonly subtitle?: ReactNode;
  /** Status affordances that sit opposite the name (health, probe). */
  readonly actions?: ReactNode;
}

export function ToolIdentityHeader({
  kind,
  id,
  fallbackName,
  avatarSize = 'md',
  subtitle,
  actions,
}: ToolIdentityHeaderProps) {
  const { t } = useI18n();
  const { resolve } = useToolIdentities();

  const defaultName = fallbackName ?? displayName(t, id);
  const identity = resolve(kind, id, defaultName);

  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <ToolAvatar
          subjectKey={identity.subjectKey}
          monogram={identity.monogram}
          name={identity.name}
          size={avatarSize}
        />
        <div className="min-w-0 space-y-1">
          <h2 className="truncate font-bold text-lg text-on-surface">{identity.name}</h2>
          {subtitle}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {actions}
        <ToolIdentityMenu identity={identity} defaultName={defaultName} />
      </div>
    </header>
  );
}
