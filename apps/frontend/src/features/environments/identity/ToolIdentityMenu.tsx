/**
 * Rename / reset for one tool, plus the dialog it opens.
 *
 * Separate from `ToolIdentityHeader` because surfaces that already have their
 * own heading — the managed-versions section, an MCP server row — still need
 * the same two actions attached to the same subject.
 */

import { MoreVertical, RotateCcw, Tag } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { IdentityEditDialog } from './IdentityEditDialog';
import type { ResolvedToolIdentity } from './resolve';
import { useResetToolIdentity } from './use-tool-identities';

interface ToolIdentityMenuProps {
  readonly identity: ResolvedToolIdentity;
  /** What the name falls back to, so the dialog can show it as the placeholder. */
  readonly defaultName: string;
  /** `icon-sm` where the buttons beside it are 28px, as in an MCP server's row of actions. */
  readonly size?: 'icon' | 'icon-sm';
}

export function ToolIdentityMenu({ identity, defaultName, size = 'icon' }: ToolIdentityMenuProps) {
  const { t } = useI18n();
  const labels = t.environments.identity;
  const reset = useResetToolIdentity();
  const { toast } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  return (
    <>
      <Menu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        panelClassName="w-48"
        trigger={(triggerProps) => (
          <Button
            type="button"
            variant="subtle"
            size={size}
            {...triggerProps}
            aria-label={formatMessage(labels.menu, { name: identity.name })}
            data-testid="tool-identity-menu"
          >
            <MoreVertical size={size === 'icon-sm' ? ICON_SM : ICON_MD} />
          </Button>
        )}
      >
        <MenuItem
          // Not a pencil: on an MCP server card the row's edit button already is one.
          icon={<Tag size={ICON_MD} />}
          onSelect={() => {
            setMenuOpen(false);
            setEditing(true);
          }}
        >
          {labels.rename}
        </MenuItem>
        <MenuItem
          icon={<RotateCcw size={ICON_MD} />}
          // Nothing to reset until something is stored; an enabled entry would
          // promise an action that does nothing.
          disabled={!identity.customized || reset.isPending}
          onSelect={() => {
            setMenuOpen(false);
            // The menu closes on select, so a failure has nowhere inline to
            // land — without this the name simply would not change and the
            // user would be left guessing why.
            reset.mutate(identity.subjectKey, {
              onError: () => toast(labels.resetFailed, 'error'),
            });
          }}
        >
          {labels.reset}
        </MenuItem>
      </Menu>

      {editing && (
        <IdentityEditDialog
          identity={identity}
          defaultName={defaultName}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
