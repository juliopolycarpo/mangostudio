import type { GithubPrSummary } from '@mangostudio/shared/github';
import { GitBranch } from 'lucide-react';
import { MenuItem } from '@/components/ui/Menu';
import { StatusDot } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { checkChipStatus } from '../lib/check-status';
import { GithubPrBadge } from './GithubPrBadge';
import { GithubRowMenu } from './GithubRowMenu';
import { GithubRowShell } from './GithubRowShell';

interface GithubPrRowProps {
  readonly chatId: string;
  readonly nameWithOwner: string;
  readonly pr: GithubPrSummary;
  readonly onOpen: (number: number) => void;
  readonly onCheckout: (number: number) => void;
}

/**
 * One pull request in the repository list.
 *
 * The whole row opens the detail view rather than the pull request on GitHub —
 * the panel exists so the answer is here, and "open in browser" is one menu
 * entry away for when it is not.
 *
 * @example
 * <GithubPrRow chatId={chatId} nameWithOwner="mango/studio" pr={pr} onOpen={setSelected} onCheckout={checkout} />
 */
export function GithubPrRow({ chatId, nameWithOwner, pr, onOpen, onCheckout }: GithubPrRowProps) {
  const { t } = useI18n();
  const checks = checkChipStatus(pr.checks);

  return (
    <GithubRowShell>
      <button
        type="button"
        onClick={() => onOpen(pr.number)}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs text-fg-muted">
            {formatMessage(t.github.row.number, { number: String(pr.number) })}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{pr.title}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          <StatusDot tone={checks.tone} />
          <span className="shrink-0">{t.github.chip[checks.labelKey]}</span>
          {pr.author ? (
            <span className="min-w-0 truncate">
              {formatMessage(t.github.row.author, { author: pr.author.login })}
            </span>
          ) : null}
        </span>
      </button>
      <GithubPrBadge state={pr.state} draft={pr.isDraft} />
      <GithubRowMenu chatId={chatId} target={{ url: pr.url, number: pr.number, nameWithOwner }}>
        <MenuItem onSelect={() => onCheckout(pr.number)} icon={<GitBranch size={ICON_MD} />}>
          {t.github.actions.checkout}
        </MenuItem>
      </GithubRowMenu>
    </GithubRowShell>
  );
}
