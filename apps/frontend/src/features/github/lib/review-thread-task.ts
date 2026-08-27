/**
 * Turning a pull request's open review conversations into a message the agent
 * can act on.
 *
 * This is the reason the GitHub panel is a panel and not a browser tab. Reading
 * review comments in a browser and retyping them into the composer is the loop
 * this replaces; the value is entirely in *which* comments make it across.
 *
 * Pure and dependency-free so it can be tested on its own — the labels arrive
 * as a parameter rather than through `useI18n`, which is also what lets the
 * caller stay a click handler instead of a hook.
 */

import type { GithubReviewThread } from '@mangostudio/shared/github';
import type { Messages } from '@mangostudio/shared/i18n';
import { formatMessage } from '@/lib/i18n-format';

type ReviewTaskLabels = Messages['github']['reviewTask'];

/**
 * Threads still worth acting on: unresolved *and* anchored in the current diff.
 *
 * Resolved threads are done. Outdated ones are the subtler exclusion: their
 * anchor no longer exists in the diff, so `line` is null and the code the
 * comment is about has already been rewritten. Sending either to an agent asks
 * it to re-do settled work, and a task list that includes finished items is one
 * the reader stops trusting.
 *
 * @example
 * openReviewThreads(response.threads).length; // 3
 */
export function openReviewThreads(
  threads: readonly GithubReviewThread[]
): readonly GithubReviewThread[] {
  return threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
}

/**
 * Formats open review threads as a numbered task list for the composer.
 *
 * Returns an empty string when nothing is open and the list is not
 * truncated, so the caller has one condition to test rather than a heading
 * with no items under it.
 *
 * @param truncated True when the pinned GraphQL document's fixed pages cut
 *   off a thread or a comment — see `GITHUB_PR_REVIEW_THREADS_QUERY`. An
 *   agent told "these are the unresolved review comments" from a silently
 *   partial list would act on less than actually exists; a note naming the
 *   gap is appended instead, even when what did arrive is otherwise empty,
 *   since a truncated empty page is not the same claim as a real one.
 *
 * @example
 * reviewThreadsToTask(threads, 'mango/studio#942', t.github.reviewTask);
 * // "Address these unresolved review comments on mango/studio#942:\n\n1. src/a.ts:42\n   alice: Rename this."
 */
export function reviewThreadsToTask(
  threads: readonly GithubReviewThread[],
  reference: string,
  labels: ReviewTaskLabels,
  truncated = false
): string {
  const open = openReviewThreads(threads);
  const truncatedNote = truncated ? formatMessage(labels.truncated, { reference }) : null;

  if (open.length === 0) return truncatedNote ?? '';

  const heading = formatMessage(labels.heading, { reference });
  const items = open.map((thread, index) => formatThread(thread, index + 1, labels));
  const body = `${heading}\n\n${items.join('\n\n')}`;
  return truncatedNote ? `${body}\n\n${truncatedNote}` : body;
}

/** `path:line`, or just the path on a thread GitHub anchored to a whole file. */
function formatLocation(thread: GithubReviewThread, labels: ReviewTaskLabels): string {
  if (thread.line === null) return formatMessage(labels.noLine, { path: thread.path });
  return formatMessage(labels.withLine, { path: thread.path, line: String(thread.line) });
}

function formatThread(
  thread: GithubReviewThread,
  position: number,
  labels: ReviewTaskLabels
): string {
  const comments = thread.comments.map((comment) =>
    formatMessage(labels.comment, {
      // A deleted account is GitHub's "ghost" user and comes back as null. The
      // comment it left is still the thing to act on, so the thread is kept and
      // only the name is replaced.
      author: comment.author?.login ?? labels.unknownAuthor,
      body: collapseWhitespace(comment.body),
    })
  );
  return [`${position}. ${formatLocation(thread, labels)}`, ...comments.map(indent)].join('\n');
}

/**
 * Review bodies are markdown and routinely span paragraphs. Left as-is they
 * break the one-item-per-line shape that makes the list readable, so every run
 * of whitespace becomes a single space and each comment stays one line.
 */
function collapseWhitespace(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function indent(line: string): string {
  return `   ${line}`;
}
