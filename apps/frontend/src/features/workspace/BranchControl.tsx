import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { GitBranchInfo } from '@mangostudio/shared/git';
import { Check, ChevronDown, GitBranch, MoreHorizontal, Plus } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASS, Input } from '@/components/ui/Input';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useToast } from '@/components/ui/Toast';
import { BranchPrTag, useBranchPrAnnotations } from '@/features/github/components/BranchPrTag';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { ApiError, cn, resolveApiErrorMessage } from '@/lib/utils';
import { IconButton } from './components/IconButton';
import { DialogCodeBlock, DialogPathList, WorkspaceDialog } from './components/WorkspaceDialog';
import {
  useCheckoutRemoteBranch,
  useCreateBranch,
  useDeleteBranch,
  useGitBranches,
  useRenameBranch,
  useStashSave,
  useSwitchBranch,
} from './hooks/use-git-state';

export function BranchControl({
  chatId,
  branch,
  detachedLabel,
}: {
  readonly chatId: string;
  readonly branch: GitBranchInfo;
  readonly detachedLabel: string;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.branch;
  const branches = useGitBranches(chatId);
  const prAnnotations = useBranchPrAnnotations(chatId);
  const switchMutation = useSwitchBranch(chatId);
  const createMutation = useCreateBranch(chatId);
  const checkoutRemoteMutation = useCheckoutRemoteBranch(chatId);
  const stashMutation = useStashSave(chatId);
  const renameMutation = useRenameBranch(chatId);
  const deleteMutation = useDeleteBranch(chatId);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [newBranch, setNewBranch] = useState('');
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // `notMerged` upgrades the confirm dialog after Git refuses a safe delete.
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; notMerged: boolean } | null>(
    null
  );
  // `remoteRef` is set only when the blocked checkout targeted a remote-tracking
  // ref: retrying it must re-create the local tracking branch, not `git switch`
  // a local branch that does not exist yet.
  const [blockedSwitch, setBlockedSwitch] = useState<{
    name: string;
    remoteRef?: string;
    paths: string[];
  } | null>(null);
  const branchName = branch.name ?? detachedLabel;
  const pending =
    switchMutation.isPending ||
    createMutation.isPending ||
    stashMutation.isPending ||
    checkoutRemoteMutation.isPending;

  const switchTo = async (name: string) => {
    if (name === branch.name) return;
    try {
      await switchMutation.mutateAsync(name);
      menuRef.current?.removeAttribute('open');
      toast(labels.switched.replace('{branch}', name), 'success');
    } catch (error) {
      if (error instanceof ApiError && error.code === ERROR_CODES.CHECKOUT_BLOCKED) {
        setBlockedSwitch({
          name,
          paths: error.details?.paths?.split('\n').filter(Boolean) ?? [],
        });
        return;
      }
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const checkoutRemote = async (remoteRef: string, localName: string) => {
    try {
      await checkoutRemoteMutation.mutateAsync(remoteRef);
      menuRef.current?.removeAttribute('open');
      toast(labels.switched.replace('{branch}', localName), 'success');
    } catch (error) {
      if (error instanceof ApiError && error.code === ERROR_CODES.CHECKOUT_BLOCKED) {
        setBlockedSwitch({
          name: localName,
          remoteRef,
          paths: error.details?.paths?.split('\n').filter(Boolean) ?? [],
        });
        return;
      }
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = newBranch.trim();
    if (!name) return;
    try {
      await createMutation.mutateAsync(name);
      setNewBranch('');
      menuRef.current?.removeAttribute('open');
      toast(labels.created.replace('{branch}', name), 'success');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const stashAndSwitch = async () => {
    if (!blockedSwitch) return;
    try {
      await stashMutation.mutateAsync({
        message: labels.stashMessage.replace('{branch}', blockedSwitch.name),
        includeUntracked: true,
      });
      if (blockedSwitch.remoteRef) {
        await checkoutRemoteMutation.mutateAsync(blockedSwitch.remoteRef);
      } else {
        await switchMutation.mutateAsync(blockedSwitch.name);
      }
      toast(labels.switched.replace('{branch}', blockedSwitch.name), 'success');
      setBlockedSwitch(null);
      menuRef.current?.removeAttribute('open');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const newName = renameValue.trim();
    if (!renameTarget || !newName) return;
    try {
      await renameMutation.mutateAsync({ name: renameTarget, newName });
      setRenameTarget(null);
      setRenameValue('');
      toast(labels.renamed.replace('{branch}', newName), 'success');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const remove = async (force: boolean) => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({
        name: deleteTarget.name,
        ...(force ? { force: true } : {}),
      });
      toast(labels.deleted.replace('{branch}', deleteTarget.name), 'success');
      setDeleteTarget(null);
    } catch (error) {
      // Git only reports unmerged work when it refuses the safe delete, so the
      // dialog earns its force option instead of offering it up front.
      if (error instanceof ApiError && error.code === ERROR_CODES.BRANCH_NOT_MERGED) {
        setDeleteTarget({ name: deleteTarget.name, notMerged: true });
        return;
      }
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const remotes = branches.data?.remotes ?? [];

  return (
    <>
      <details ref={menuRef} className="relative">
        <summary
          aria-label={labels.menu}
          className="flex h-8 cursor-pointer list-none items-center gap-2 rounded-sm px-2 text-fg transition-colors hover:bg-fill-hover [&::-webkit-details-marker]:hidden"
        >
          <GitBranch size={ICON_MD} className="shrink-0 text-fg-muted" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs font-medium"
            title={branchName}
          >
            {branchName}
          </span>
          <ChevronDown size={ICON_SM} className="shrink-0 text-fg-muted" />
        </summary>
        <div className="absolute left-0 right-0 top-full z-30 mt-1 min-w-64 rounded-md border border-stroke bg-surface-raised shadow-popover">
          {/* Scrolling is dropped while a row menu is open so the popover is not clipped by this container. */}
          <div
            className={`max-h-64 p-1 ${
              rowMenu === null ? 'app-scrollbar overflow-y-auto' : 'overflow-visible'
            }`}
          >
            {branches.isLoading ? (
              <p className="px-2 py-3 text-xs text-fg-muted">{t.common.loading}</p>
            ) : (
              <>
                <MicroLabel as="p" className="block px-2 py-1">
                  {labels.localSection}
                </MicroLabel>
                {branches.data?.branches.length ? (
                  branches.data.branches.map((item) => (
                    <div
                      key={item.name}
                      className={cn(
                        'flex items-center gap-1 rounded-sm pr-1 transition-colors hover:bg-fill-hover',
                        item.current && 'bg-fill-selected'
                      )}
                    >
                      <button
                        type="button"
                        disabled={pending || item.current}
                        onClick={() => void switchTo(item.name)}
                        aria-label={labels.switchTo.replace('{branch}', item.name)}
                        title={item.name}
                        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-2 text-left disabled:cursor-default"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                          {item.name}
                        </span>
                        {/* Which pull request this branch became, and whether
                            it is merged — so "delete" is an informed click
                            rather than a guess. */}
                        <BranchPrTag annotation={prAnnotations.get(item.name)} />
                        {item.current ? (
                          <Check size={ICON_MD} className="shrink-0 text-accent-fg" />
                        ) : null}
                      </button>
                      <Menu
                        open={rowMenu === item.name}
                        onOpenChange={(next) => setRowMenu(next ? item.name : null)}
                        panelClassName="w-40"
                        trigger={(triggerProps) => (
                          <IconButton
                            label={labels.itemMenu.replace('{branch}', item.name)}
                            {...triggerProps}
                          >
                            <MoreHorizontal size={ICON_SM} />
                          </IconButton>
                        )}
                      >
                        <MenuItem
                          disabled={pending}
                          onSelect={() => {
                            setRowMenu(null);
                            setRenameValue(item.name);
                            setRenameTarget(item.name);
                          }}
                        >
                          {labels.rename}
                        </MenuItem>
                        <MenuItem
                          tone="danger"
                          disabled={pending || item.current}
                          onSelect={() => {
                            setRowMenu(null);
                            setDeleteTarget({ name: item.name, notMerged: false });
                          }}
                        >
                          {labels.delete}
                        </MenuItem>
                      </Menu>
                    </div>
                  ))
                ) : (
                  <p className="px-2 py-3 text-xs text-fg-muted">{labels.empty}</p>
                )}
                {remotes.length > 0 ? (
                  <>
                    <MicroLabel as="p" className="mt-1 block px-2 py-1">
                      {labels.remoteSection}
                    </MicroLabel>
                    {remotes.map((item) => (
                      <button
                        key={item.ref}
                        type="button"
                        disabled={pending}
                        onClick={() => void checkoutRemote(item.ref, item.name)}
                        aria-label={labels.checkoutRemote.replace('{branch}', item.ref)}
                        title={item.ref}
                        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left transition-colors hover:bg-fill-hover disabled:cursor-default"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                          {item.ref}
                        </span>
                      </button>
                    ))}
                  </>
                ) : null}
              </>
            )}
          </div>
          <form onSubmit={(event) => void create(event)} className="border-t border-stroke p-2">
            <label className="sr-only" htmlFor="git-create-branch">
              {labels.create}
            </label>
            <div className="flex gap-2">
              <input
                id="git-create-branch"
                value={newBranch}
                onChange={(event) => setNewBranch(event.target.value)}
                placeholder={labels.createPlaceholder}
                className={cn(FIELD_CLASS, 'min-w-0 flex-1 font-mono text-xs')}
              />
              <Button
                type="submit"
                size="icon"
                disabled={pending || !newBranch.trim()}
                aria-label={labels.create}
              >
                <Plus size={ICON_MD} />
              </Button>
            </div>
          </form>
        </div>
      </details>

      {renameTarget ? (
        <WorkspaceDialog
          titleId="git-branch-rename-title"
          title={labels.renameTitle.replace('{branch}', renameTarget)}
          onSubmit={(event) => void rename(event)}
          footer={
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setRenameTarget(null);
                  setRenameValue('');
                }}
              >
                {labels.renameCancel}
              </Button>
              <Button
                type="submit"
                loading={renameMutation.isPending}
                disabled={!renameValue.trim() || renameValue.trim() === renameTarget}
              >
                {labels.renameConfirm}
              </Button>
            </>
          }
        >
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            aria-label={labels.renameLabel}
            placeholder={labels.createPlaceholder}
            className="font-mono"
          />
        </WorkspaceDialog>
      ) : null}

      {deleteTarget ? (
        <WorkspaceDialog
          titleId="git-branch-delete-title"
          title={
            deleteTarget.notMerged
              ? labels.deleteNotMergedTitle
              : labels.deleteTitle.replace('{branch}', deleteTarget.name)
          }
          description={deleteTarget.notMerged ? labels.deleteNotMergedHint : labels.deleteHint}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setDeleteTarget(null)}>
                {labels.deleteCancel}
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={deleteMutation.isPending}
                onClick={() => void remove(deleteTarget.notMerged)}
              >
                {deleteTarget.notMerged ? labels.deleteNotMergedConfirm : labels.deleteConfirm}
              </Button>
            </>
          }
        >
          <DialogCodeBlock className="truncate">{deleteTarget.name}</DialogCodeBlock>
        </WorkspaceDialog>
      ) : null}

      {blockedSwitch ? (
        <WorkspaceDialog
          titleId="git-checkout-blocked-title"
          title={labels.checkoutBlockedTitle}
          description={labels.checkoutBlockedHint}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setBlockedSwitch(null)}>
                {labels.cancel}
              </Button>
              <Button type="button" loading={pending} onClick={() => void stashAndSwitch()}>
                {labels.stashAndSwitch}
              </Button>
            </>
          }
        >
          {blockedSwitch.paths.length > 0 ? (
            <div className="space-y-1.5">
              <MicroLabel as="p" className="block">
                {labels.conflictingPaths}
              </MicroLabel>
              <DialogPathList paths={blockedSwitch.paths} />
            </div>
          ) : null}
        </WorkspaceDialog>
      ) : null}
    </>
  );
}
