import type { FeatureMessages } from './types';

/**
 * The English `github` keys the first paint does not read (the rest stay in `en.ts`).
 * The feature's lazy chunk imports this file, so the strings arrive with the code
 * that renders them (see `FeatureNamespace` in `types.ts`).
 */
export const messages: FeatureMessages<'github'> = {
  github: {
    loading: 'Reading GitHub context…',
    /**
     * The pull request badge vocabulary, keyed lowercase because its one caller
     * indexes it with `state.toLowerCase()` and it carries `draft`, which is not
     * a pull request state at all.
     */
    states: {
      open: 'Open',
      closed: 'Closed',
      merged: 'Merged',
      draft: 'Draft',
    },

    /**
     * Per-branch annotation in the branch list. Only `MERGED` earns a sentence
     * of its own. Says the pull request merged, not that deleting the branch
     * is safe — Git's own refusal on an unmerged tip is what decides that.
     */
    branchPr: {
      merged: 'merged',
    },

    /**
     * Keyed by the wire value of the four not-connected states so the panel can
     * index straight off the response instead of switching on it. One sentence
     * per state, and one hint that says what to do about it.
     */
    connection: {
      'gh-not-installed': 'GitHub CLI is not installed where this chat runs.',
      'not-authenticated': 'GitHub CLI is not signed in where this chat runs.',
      'no-remote': 'This repository has no remote.',
      'not-a-github-remote': 'This repository does not have a GitHub remote.',
    },
    // A hint that names a command to type does not spell it out: signing in puts
    // the command in a copyable box under the sentence, and `{command}` marks the
    // slot an inline command fills (see `GithubNotConnected`).
    connectionHint: {
      'gh-not-installed': 'Install the GitHub CLI on that machine, then refresh.',
      'not-authenticated': 'Run this on that machine, then refresh.',
      'no-remote': 'Add a remote with {command} on that machine, then refresh.',
      'not-a-github-remote': 'The GitHub panel only reads repositories hosted on GitHub.',
    },

    empty: {
      prs: 'No pull requests match this filter.',
      issues: 'No issues match this filter.',
      inbox: 'Nothing is waiting on your review.',
      checks: 'This pull request runs no checks.',
      threads: 'No review comments on this pull request.',
    },

    issueState: {
      OPEN: 'Open',
      CLOSED: 'Closed',
    },
    reviewDecision: {
      APPROVED: 'Approved',
      CHANGES_REQUESTED: 'Changes requested',
      REVIEW_REQUIRED: 'Review required',
    },
    /** Lives outside `reviewDecision`: "none" is a null, not a member of the union. */
    reviewDecisionNone: 'No review yet',
    checkBucket: {
      pass: 'Passed',
      fail: 'Failed',
      pending: 'Running',
      skipping: 'Skipped',
      cancel: 'Cancelled',
    },
    mergeState: {
      BEHIND: 'Behind the base branch',
      BLOCKED: 'Merge blocked',
      CLEAN: 'Ready to merge',
      DIRTY: 'Conflicts with the base branch',
      DRAFT: 'Still a draft',
      HAS_HOOKS: 'Ready to merge, with repository hooks',
      UNKNOWN: 'Merge state unknown',
      UNSTABLE: 'Mergeable, but checks are failing',
    },
    mergeable: {
      MERGEABLE: 'No conflicts',
      CONFLICTING: 'Has conflicts',
      UNKNOWN: 'Checking for conflicts',
    },
    prFilter: {
      open: 'Open',
      mine: 'Mine',
      'review-requested': 'Review requested',
      all: 'All',
    },
    issueFilter: {
      open: 'Open',
      assigned: 'Assigned to me',
      mine: 'Created by me',
    },

    row: {
      number: '#{number}',
      draft: 'Draft',
      author: 'by {author}',
      bot: 'bot',
      diffStat: '+{additions} / -{deletions} across {files} files',
      assignees: 'Assigned to {assignees}',
      unassigned: 'Unassigned',
      labels: 'Labels',
    },

    createPr: {
      title: 'Create pull request',
      titleLabel: 'Title',
      titlePlaceholder: 'e.g. Fix redirect after sign-in',
      bodyLabel: 'Description',
      bodyPlaceholder: 'e.g. The redirect used an expired session',
      draftLabel: 'Create as a draft',
      submit: 'Create pull request',
      cancel: 'Cancel',
      success: 'Pull request #{number} created.',
      error: 'The pull request could not be created.',
      createdUnreadable:
        'The pull request was created, but its details could not be read back. Do not create it again.',
      openOnGithub: 'Open on GitHub',
      done: 'Done',
      pushHint:
        'This branch does not exist on the remote yet. It will be pushed before the pull request is opened.',
      pushError: 'The branch could not be pushed, so no pull request was created.',
      noBranch: 'Check out a branch to create a pull request.',
      readOnly:
        'GitHub writes are turned off on this machine, so pull requests can only be read here.',
    },

    /**
     * The text the "review comments" action writes into the composer. It lives
     * in i18n like any other visible sentence: it is a message somebody reads
     * and edits before sending, not a wire format.
     */
    reviewTask: {
      heading: 'Address these unresolved review comments on {reference}:',
      withLine: '{path}:{line}',
      noLine: '{path}',
      comment: '{author}: {body}',
      unknownAuthor: 'someone',
      truncated:
        'This pull request has more review threads or comments than fit here — check {reference} on GitHub for the rest.',
    },

    staleness: {
      updated: 'Updated {relative}',
      refreshing: 'Refreshing…',
    },

    errors: {
      prs: 'Pull requests could not be loaded.',
      issues: 'Issues could not be loaded.',
      inbox: 'Your review queue could not be loaded.',
      checks: 'Checks could not be loaded.',
      threads: 'Review comments could not be loaded.',
      action: 'The GitHub action failed.',
    },
  },
};
