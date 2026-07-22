import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { GitBranchInfo } from '@mangostudio/shared/git';
import { Check, ChevronDown, Cloud, GitBranch, Plus } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ApiError, resolveApiErrorMessage } from '@/lib/utils';
import {
  useCheckoutRemoteBranch,
  useCreateBranch,
  useGitBranches,
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
  const switchMutation = useSwitchBranch(chatId);
  const createMutation = useCreateBranch(chatId);
  const checkoutRemoteMutation = useCheckoutRemoteBranch(chatId);
  const stashMutation = useStashSave(chatId);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [newBranch, setNewBranch] = useState('');
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
        <div className="absolute left-0 right-0 top-full z-30 mt-1 min-w-64 overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-high shadow-2xl">
          <div className="app-scrollbar max-h-64 overflow-y-auto p-1.5">
            {branches.isLoading ? (
              <p className="px-2 py-3 text-xs text-on-surface-variant">{t.common.loading}</p>
            ) : (
              <>
                <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                  {labels.localSection}
                </p>
                {branches.data?.branches.length ? (
                  branches.data.branches.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      disabled={pending || item.current}
                      onClick={() => void switchTo(item.name)}
                      aria-label={labels.switchTo.replace('{branch}', item.name)}
                      title={item.name}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-container-highest disabled:cursor-default"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-on-surface">
                        {item.name}
                      </span>
                      {item.current ? <Check size={13} className="text-primary" /> : null}
                    </button>
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
