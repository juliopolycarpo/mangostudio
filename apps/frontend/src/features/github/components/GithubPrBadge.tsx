import type { GithubPrState } from '@mangostudio/shared/github';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';

interface GithubPrBadgeProps {
  readonly state: GithubPrState;
  readonly draft: boolean;
}

/**
 * A pull request's state as a chip, draft included.
 *
 * Draft outranks the state rather than sitting beside it: an open draft is not
 * meaningfully "open" to anyone deciding what to review next, and two chips
 * where one will do is two things to read.
 *
 * Extracted out of `GitPanel` so the GitHub panel, the branch list and the
 * Repository panel's chip all paint the same vocabulary the same colours.
 *
 * @example
 * <GithubPrBadge state="MERGED" draft={false} />
 */
export function GithubPrBadge({ state, draft }: GithubPrBadgeProps) {
  const { t } = useI18n();
  const label = draft
    ? t.github.states.draft
    : t.github.states[state.toLowerCase() as Lowercase<GithubPrState>];

  return (
    <Badge
      variant={badgeVariant(state, draft)}
      className="px-1.5 py-0.5 text-[9px] tracking-normal"
    >
      {label}
    </Badge>
  );
}

function badgeVariant(state: GithubPrState, draft: boolean) {
  if (draft) return 'warning' as const;
  if (state === 'OPEN') return 'success' as const;
  if (state === 'MERGED') return 'accent' as const;
  return 'neutral' as const;
}
