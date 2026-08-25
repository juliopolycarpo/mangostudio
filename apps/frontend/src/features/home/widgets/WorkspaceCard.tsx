/**
 * "Where am I, and is anything uncommitted here?" — the first question the hub
 * answers, from the per-chat Git state the rail already loads.
 *
 * Shares `useGitState`'s query with the workspace rail and the breadcrumb, so
 * opening a new chat costs one `GET /git/state` between the three of them.
 */

import type { GitRepoState } from '@mangostudio/shared/git';
import { FolderOpen, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SectionCard } from '@/components/ui/SectionCard';
import type { StatusDotTone } from '@/components/ui/StatusDot';
import { useGitState } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { workdirLabel } from '@/lib/paths';
import { HubSkeletonLines } from './HubSkeletonLines';

interface WorkspaceCardProps {
  chatId: string;
  /** The chat's folder, known before Git has answered anything about it. */
  workdir: string | null;
  onChooseWorkdir?: () => void;
}

export function WorkspaceCard({ chatId, workdir, onChooseWorkdir }: WorkspaceCardProps) {
  const { t } = useI18n();
  const labels = t.home.workspace;
  const gitState = useGitState(chatId);
  // Re-annotated rather than read off the result: TS7 does not narrow a
  // discriminated union taken straight off a query result, and every branch
  // below is a discriminant check.
  const state: GitRepoState | undefined = gitState.data;

  const folder = workdirLabel(workdir);

  return (
    <SectionCard label={labels.label} tone={cardTone(state)}>
      {folder ? (
        <p className="truncate font-mono text-sm text-on-surface" title={workdir ?? undefined}>
          {folder}
        </p>
      ) : null}

      {gitState.isPending && folder ? <HubSkeletonLines /> : null}

      {state?.state === 'repo' ? <RepoLines status={state.status} /> : null}

      {state?.state === 'not-a-repo' ? (
        <p className="text-xs text-on-surface-variant">{labels.notARepo}</p>
      ) : null}

      {state?.state === 'git-unavailable' ? (
        <p className="text-xs text-on-surface-variant">{labels.unavailable}</p>
      ) : null}

      {!folder ? (
        <div className="space-y-2">
          <p className="text-xs text-on-surface-variant">{labels.noWorkdir}</p>
          {onChooseWorkdir ? (
            <Button variant="secondary" size="sm" onClick={onChooseWorkdir} className="gap-1.5">
              <FolderOpen size={13} />
              {labels.chooseWorkdir}
            </Button>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}

function cardTone(state: GitRepoState | undefined): StatusDotTone {
  if (state?.state !== 'repo') return 'neutral';
  return state.status.clean ? 'success' : 'warning';
}

function RepoLines({ status }: { status: Extract<GitRepoState, { state: 'repo' }>['status'] }) {
  const { t } = useI18n();
  const labels = t.home.workspace;
  const { branch } = status;
  const changed =
    status.staged.length +
    status.unstaged.length +
    status.untracked.length +
    status.conflicted.length;

  return (
    <div className="space-y-1.5 font-mono text-xs">
      <p className="flex min-w-0 items-center gap-1.5 text-on-surface-variant">
        <GitBranch size={12} aria-hidden="true" className="shrink-0" />
        <span className="truncate text-on-surface">
          {branch.name ??
            formatMessage(labels.detached, { hash: branch.detachedAt?.slice(0, 7) ?? '' })}
        </span>
      </p>
      <p className="text-on-surface-variant">
        <span className={status.clean ? 'text-success' : 'text-warning'}>
          {status.clean
            ? labels.cleanTree
            : formatMessage(labels.dirtyTree, {
                count: String(changed),
              })}
        </span>
        {' · '}
        {syncLine(branch, labels, t.sidebar.git.sync)}
      </p>
    </div>
  );
}

function syncLine(
  branch: Extract<GitRepoState, { state: 'repo' }>['status']['branch'],
  labels: { synced: string; noUpstream: string },
  syncTemplate: string
): string {
  if (!branch.upstream) return labels.noUpstream;
  if (branch.ahead === 0 && branch.behind === 0) return labels.synced;
  return formatMessage(syncTemplate, {
    ahead: String(branch.ahead),
    behind: String(branch.behind),
  });
}
