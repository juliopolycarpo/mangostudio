import { ClipboardCopy, CornerDownLeft, ExternalLink, Hash, MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { useI18n } from '@/hooks/use-i18n';
import type { GithubReferenceTarget } from '../hooks/use-github-quick-actions';
import { useGithubQuickActions } from '../hooks/use-github-quick-actions';

interface GithubRowMenuProps {
  readonly chatId: string;
  readonly target: GithubReferenceTarget;
  /** Row-specific entries (checkout, mark ready, new chat) above the shared four. */
  readonly children?: ReactNode;
}

/**
 * The overflow menu every GitHub row carries.
 *
 * The four quick actions are identical on a pull request, an issue and an inbox
 * row, so they live here once and the caller passes only what is specific to
 * its kind. That is also why `children` renders *above* them: the row's own
 * action is what somebody opened the menu for.
 *
 * @example
 * <GithubRowMenu chatId={chatId} target={{ url, number, nameWithOwner }}>
 *   <MenuItem onSelect={checkout}>Check out this branch</MenuItem>
 * </GithubRowMenu>
 */
export function GithubRowMenu({ chatId, target, children }: GithubRowMenuProps) {
  const { t } = useI18n();
  const actions = useGithubQuickActions(chatId);
  const [open, setOpen] = useState(false);

  const run = (action: (target: GithubReferenceTarget) => void) => () => {
    setOpen(false);
    action(target);
  };

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      panelClassName="w-60"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={t.common.openMenu}
          title={t.common.openMenu}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant opacity-0 transition-opacity hover:bg-surface-container-high hover:text-on-surface focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary group-hover:opacity-100"
        >
          <MoreHorizontal size={13} />
        </button>
      )}
    >
      {children ? (
        <>
          {children}
          <MenuSeparator />
        </>
      ) : null}
      <MenuItem onSelect={run(actions.openInBrowser)} icon={<ExternalLink size={13} />}>
        {t.github.actions.openInBrowser}
      </MenuItem>
      <MenuItem onSelect={run(actions.copyUrl)} icon={<ClipboardCopy size={13} />}>
        {t.github.actions.copyUrl}
      </MenuItem>
      <MenuItem onSelect={run(actions.copyReference)} icon={<Hash size={13} />}>
        {t.github.actions.copyReference}
      </MenuItem>
      <MenuItem onSelect={run(actions.pasteReference)} icon={<CornerDownLeft size={13} />}>
        {t.github.actions.pasteReference}
      </MenuItem>
    </Menu>
  );
}
