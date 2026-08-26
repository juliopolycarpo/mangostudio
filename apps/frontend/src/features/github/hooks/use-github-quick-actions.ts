/**
 * The four things somebody does with a pull request or issue row that do not
 * involve GitHub at all: open it, copy it, and hand its reference to the agent.
 *
 * A hook rather than a component so the row menu, the detail header and the
 * home widget can each render the affordance their layout wants over one
 * implementation of what the affordance does.
 */

import { useCallback } from 'react';
import { useToast } from '@/components/ui/Toast';
import {
  getComposerDraft,
  requestComposerFocus,
  setComposerDraft,
} from '@/features/chat/lib/composer-draft-store';
import { useI18n } from '@/hooks/use-i18n';

export interface GithubReferenceTarget {
  readonly url: string;
  readonly number: number;
  /** `owner/repo`, so the reference reads the way GitHub itself writes it. */
  readonly nameWithOwner: string;
}

export interface GithubQuickActions {
  readonly openInBrowser: (target: GithubReferenceTarget) => void;
  readonly copyUrl: (target: GithubReferenceTarget) => void;
  readonly copyReference: (target: GithubReferenceTarget) => void;
  readonly pasteReference: (target: GithubReferenceTarget) => void;
}

/**
 * @param chatId The conversation whose composer `pasteReference` appends to.
 *
 * @example
 * const actions = useGithubQuickActions(chatId);
 * actions.copyReference({ url, number: 942, nameWithOwner: 'mango/studio' });
 */
export function useGithubQuickActions(chatId: string): GithubQuickActions {
  const { t } = useI18n();
  const { toast } = useToast();

  const copy = useCallback(
    (text: string) => {
      // Clipboard writes reject on an unfocused document and in browsers that
      // withhold the permission. A silent failure would look like a dead
      // button, so the toast reports either way.
      void navigator.clipboard
        .writeText(text)
        .then(() => toast(t.github.actions.copied, 'success'))
        .catch(() => toast(t.github.errors.action, 'error'));
    },
    [t, toast]
  );

  return {
    openInBrowser: useCallback((target) => {
      window.open(target.url, '_blank', 'noopener,noreferrer');
    }, []),

    copyUrl: useCallback((target) => copy(target.url), [copy]),

    copyReference: useCallback((target) => copy(githubReference(target)), [copy]),

    // Appended rather than assigned: the composer may already hold half a
    // thought, and a reference is something you add to a sentence.
    pasteReference: useCallback(
      (target) => {
        setComposerDraft(chatId, appendReference(chatId, githubReference(target)));
        requestComposerFocus();
      },
      [chatId]
    ),
  };
}

/** `owner/repo#123` — GitHub's own cross-repository shorthand. */
function githubReference(target: GithubReferenceTarget): string {
  return `${target.nameWithOwner}#${target.number}`;
}

/**
 * Reads the draft at call time rather than at render time: the composer may
 * have gained a sentence since this row was painted, and overwriting it would
 * make "paste a reference" destroy the thought it was meant to annotate.
 */
function appendReference(chatId: string, reference: string): string {
  const current = getComposerDraft(chatId);
  return current ? `${current.replace(/\s+$/, '')} ${reference}` : reference;
}
