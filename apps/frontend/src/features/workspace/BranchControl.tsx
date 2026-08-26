import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { GitBranchInfo } from '@mangostudio/shared/git';
import { Check, ChevronDown, Cloud, GitBranch, MoreHorizontal, Plus } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { useToast } from '@/components/ui/Toast';
import { BranchPrTag, useBranchPrAnnotations } from '@/features/github/components/BranchPrTag';
import { useI18n } from '@/hooks/use-i18n';
import { ApiError, resolveApiErrorMessage } from '@/lib/utils';
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
      <details ref={menuRef} className="group relative">
        <summary
          aria-label={labels.menu}
          className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-1 py-1 text-on-surface transition-colors hover:bg-surface-container-high [&::-webkit-details-marker]:hidden"
        >
          <GitBranch size={15} className="shrink-0 text-primary" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs font-semibold"
            title={branchName}
          >
            {branchName}
          </span>
          <ChevronDown
            size={13}
            className="shrink-0 text-on-surface-variant transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="absolute left-0 right-0 top-full z-30 mt-1 min-w-64 rounded-xl border border-outline-variant/20 bg-surface-container-high shadow-2xl">
          {/* Scrolling is dropped while a row menu is open so the popover is not clipped by this container. */}
          <div
            className={`p-1.5 max-h-64 ${
              rowMenu === null ? 'app-scrollbar overflow-y-auto' : 'overflow-visible'
            }`}
          >
            {branches.isLoading ? (
              <p className="px-2 py-3 text-xs text-on-surface-variant">{t.common.loading}</p>
            ) : (
              <>
                <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                  {labels.localSection}
                </p>
                {branches.data?.branches.length ? (
                  branches.data.branches.map((item) => (
                    <div
                      key={item.name}
                      className="flex items-center gap-1 rounded-lg pr-1 hover:bg-surface-container-highest"
                    >
                      <button
                        type="button"
                        disabled={pending || item.current}
                        onClick={() => void switchTo(item.name)}
                        aria-label={labels.switchTo.replace('{branch}', item.name)}
                        title={item.name}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left disabled:cursor-default"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-on-surface">
                          {item.name}
                        </span>
                        {/* Which pull request this branch became, and whether
                            it is merged — so "delete" is an informed click
                            rather than a guess. */}
                        <BranchPrTag annotation={prAnnotations.get(item.name)} />
                        {item.current ? <Check size={13} className="text-primary" /> : null}
                      </button>
                      <Menu
                        open={rowMenu === item.name}
                        onOpenChange={(next) => setRowMenu(next ? item.name : null)}
                        panelClassName="w-40"
                        trigger={(triggerProps) => (
                          <button
                            type="button"
                            aria-label={labels.itemMenu.replace('{branch}', item.name)}
                            title={labels.itemMenu.replace('{branch}', item.name)}
                            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
                            {...triggerProps}
                          >
                            <MoreHorizontal size={13} />
                          </button>
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
                  <p className="px-2 py-3 text-xs text-on-surface-variant">{labels.empty}</p>
                )}
                {remotes.length > 0 ? (
                  <>
                    <p className="mt-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                      {labels.remoteSection}
                    </p>
                    {remotes.map((item) => (
                      <button
                        key={item.ref}
                        type="button"
                        disabled={pending}
                        onClick={() => void checkoutRemote(item.ref, item.name)}
                        aria-label={labels.checkoutRemote.replace('{branch}', item.ref)}
                        title={item.ref}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-container-highest disabled:cursor-default"
                      >
                        <Cloud size={12} className="shrink-0 text-on-surface-variant" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-on-surface">
                          {item.ref}
                        </span>
                      </button>
                    ))}
                  </>
                ) : null}
              </>
            )}
          </div>
          <form
            onSubmit={(event) => void create(event)}
            className="border-t border-outline-variant/15 p-2"
          >
            <label className="sr-only" htmlFor="git-create-branch">
              {labels.create}
            </label>
            <div className="flex gap-1.5">
              <input
                id="git-create-branch"
                value={newBranch}
                onChange={(event) => setNewBranch(event.target.value)}
                placeholder={labels.createPlaceholder}
                className="min-w-0 flex-1 rounded-lg border border-outline-variant/20 bg-surface-container-lowest px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary/60"
              />
              <button
                type="submit"
                disabled={pending || !newBranch.trim()}
                aria-label={labels.create}
                className="flex size-7 cursor-pointer items-center justify-center rounded-lg bg-primary text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={13} />
              </button>
            </div>
          </form>
        </div>
      </details>

      {renameTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-branch-rename-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={(event) => void rename(event)}
            className="w-full max-w-sm space-y-4 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 shadow-2xl"
          >
            <h3 id="git-branch-rename-title" className="text-lg font-bold text-on-surface">
              {labels.renameTitle.replace('{branch}', renameTarget)}
            </h3>
            <label className="block space-y-1">
              <span className="sr-only">{labels.renameLabel}</span>
              <input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                aria-label={labels.renameLabel}
                placeholder={labels.createPlaceholder}
                className="w-full rounded-lg border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 font-mono text-xs text-on-surface outline-none focus:border-primary/60"
              />
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setRenameTarget(null);
                  setRenameValue('');
                }}
              >
                {labels.renameCancel}
              </Button>
              <Button
                type="submit"
                className="flex-1"
                loading={renameMutation.isPending}
                disabled={!renameValue.trim() || renameValue.trim() === renameTarget}
              >
                {labels.renameConfirm}
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-branch-delete-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm space-y-4 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 shadow-2xl">
            <div className="space-y-2">
              <h3 id="git-branch-delete-title" className="text-lg font-bold text-on-surface">
                {deleteTarget.notMerged
                  ? labels.deleteNotMergedTitle
                  : labels.deleteTitle.replace('{branch}', deleteTarget.name)}
              </h3>
              <p className="text-sm leading-5 text-on-surface-variant">
                {deleteTarget.notMerged ? labels.deleteNotMergedHint : labels.deleteHint}
              </p>
              <p className="truncate rounded-xl bg-surface-container-lowest p-2 font-mono text-[11px]">
                {deleteTarget.name}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setDeleteTarget(null)}
              >
                {labels.deleteCancel}
              </Button>
              <Button
                type="button"
                variant="danger"
                className="flex-1"
                loading={deleteMutation.isPending}
                onClick={() => void remove(deleteTarget.notMerged)}
              >
                {deleteTarget.notMerged ? labels.deleteNotMergedConfirm : labels.deleteConfirm}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {blockedSwitch ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-checkout-blocked-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm space-y-4 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 shadow-2xl">
            <div className="space-y-2">
              <h3 id="git-checkout-blocked-title" className="text-lg font-bold text-on-surface">
                {labels.checkoutBlockedTitle}
              </h3>
              <p className="text-sm leading-5 text-on-surface-variant">
                {labels.checkoutBlockedHint}
              </p>
            </div>
            {blockedSwitch.paths.length > 0 ? (
              <div>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                  {labels.conflictingPaths}
                </p>
                <ul className="max-h-32 overflow-y-auto rounded-xl bg-surface-container-lowest p-2 font-mono text-[11px]">
                  {blockedSwitch.paths.map((path) => (
                    <li key={path} className="truncate py-0.5" title={path}>
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setBlockedSwitch(null)}
              >
                {labels.cancel}
              </Button>
              <Button
                type="button"
                className="flex-1"
                loading={pending}
                onClick={() => void stashAndSwitch()}
              >
                {labels.stashAndSwitch}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
