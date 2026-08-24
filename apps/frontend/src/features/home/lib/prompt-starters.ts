/**
 * Prompt starters chosen from what the workspace is actually doing.
 *
 * A cockpit sitting on a dirty checkout can offer something better than
 * "explain a complex concept": the two prompts anyone types next are "what did
 * I change" and "write the commit message". When there is no repository to
 * reason about, the generic set is still the right answer — this degrades to
 * it rather than showing starters that would send the agent looking for files
 * that are not there.
 */

import type { GitRepoState } from '@mangostudio/shared/git';

export type StarterContext = 'dirty' | 'branch' | 'repo' | 'none';

export const PROMPT_STARTER_IDS = [
  'reviewChanges',
  'commitMessage',
  'branchSummary',
  'explainCodebase',
  'writeTests',
  'explainConcept',
  'pythonScript',
  'debug',
] as const;

export type PromptStarterId = (typeof PROMPT_STARTER_IDS)[number];

const STARTERS_BY_CONTEXT: Readonly<Record<StarterContext, readonly PromptStarterId[]>> = {
  dirty: ['reviewChanges', 'commitMessage', 'explainCodebase'],
  branch: ['branchSummary', 'explainCodebase', 'debug'],
  // A clean detached HEAD has no branch to summarize, so the branch starter is
  // dropped rather than asking the agent about a branch that does not exist.
  repo: ['explainCodebase', 'writeTests', 'debug'],
  none: ['explainConcept', 'pythonScript', 'debug'],
};

/**
 * `undefined` covers both "still loading" and "the query failed", which want
 * the same answer: the starters that hold for any workspace. Showing
 * repository-specific prompts on a guess and swapping them out a moment later
 * would be worse than never offering them.
 *
 * // Usage: starterContext(useGitState(chatId).data)
 */
export function starterContext(state: GitRepoState | undefined): StarterContext {
  if (state?.state !== 'repo') return 'none';
  if (!state.status.clean) return 'dirty';
  return state.status.branch.name === null ? 'repo' : 'branch';
}

export function promptStarterIds(context: StarterContext): readonly PromptStarterId[] {
  return STARTERS_BY_CONTEXT[context];
}
