import type { GithubUnavailableState } from '@mangostudio/shared/github';
import type { ReactNode } from 'react';
import { Callout } from '@/components/ui/Callout';
import { SignInCommand } from '@/features/external-agents/SignInCommand';
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
 * What to type, as shell commands rather than prose: they are not translated,
 * only the sentence around them is. Signing in is the runner callout's own
 * pattern (a sentence, then the command in a copyable box); a missing remote
 * has a placeholder to fill in before it can run, so it is named inline where
 * the hint puts `{command}` instead of offering a copy of something unrunnable.
 */
const SIGN_IN_COMMAND = 'gh auth login';
const ADD_REMOTE_COMMAND = 'git remote add origin';

/** A hint with a `{command}` slot, the command drawn as inline code (the markdown look). */
function HintWithCommand({ hint, command }: { readonly hint: string; readonly command: string }) {
  const [before, after = ''] = hint.split('{command}');
  return (
    <>
      {before}
      <code className="rounded-xs bg-fill-selected px-1 font-mono text-xs">{command}</code>
      {after}
    </>
  );
}

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
  const hint = t.github.connectionHint[state];

  return (
    <Callout tone={TONE[state]} title={t.github.connection[state]} action={action}>
      {state === 'not-authenticated' ? (
        <div className="space-y-2">
          <p>{hint}</p>
          <SignInCommand command={SIGN_IN_COMMAND} />
        </div>
      ) : state === 'no-remote' ? (
        <HintWithCommand hint={hint} command={ADD_REMOTE_COMMAND} />
      ) : (
        hint
      )}
    </Callout>
  );
}
