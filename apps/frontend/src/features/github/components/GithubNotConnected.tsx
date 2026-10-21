import type { GithubUnavailableState } from '@mangostudio/shared/github';
import type { ReactNode } from 'react';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';

type UnavailableKind = GithubUnavailableState['state'];

interface GithubNotConnectedProps {
  readonly state: UnavailableKind;
  /** The way out, when the caller owns one: the panel-wide notice offers a refresh. */
  readonly action?: ReactNode;
}

/**
 * How each state is drawn. Three are something the person can fix (sign in,
 * install `gh`, add a remote), which `patterns.md` calls a `warning`; a
 * repository hosted elsewhere is a fact about the panel's reach with nothing to
 * fix, so it is `info`. A record rather than a `switch`, so adding a fifth state
 * fails to compile here instead of silently drawing the wrong tone.
 */
const TONE: Readonly<Record<UnavailableKind, 'warning' | 'info'>> = {
  'gh-not-installed': 'warning',
  'not-authenticated': 'warning',
  'no-remote': 'warning',
  'not-a-github-remote': 'info',
};

/**
 * The one renderer for all four not-connected states.
 *
 * One component, not four branches, because the contract went to some trouble
 * to make these a single shared union: a user who is simply logged out must get
 * the same explanation whichever section they are looking at. The state indexes
 * two i18n blocks directly rather than being switched on, so adding a fifth
 * state is a translation change and not a component change.
 *
 * A `Callout`, not an `EmptyState`: this is a problem the person can act on,
 * read inline beside the controls it makes inert, not a statement that a list
 * has nothing in it. Left-aligned, so it reads in the panel's own column.
 *
 * @example
 * if (data.state !== 'ok') return <GithubNotConnected state={data.state} />;
 */
export function GithubNotConnected({ state, action }: GithubNotConnectedProps) {
  const { t } = useI18n();

  return (
    <Callout tone={TONE[state]} title={t.github.connection[state]} action={action}>
      {t.github.connectionHint[state]}
    </Callout>
  );
}
