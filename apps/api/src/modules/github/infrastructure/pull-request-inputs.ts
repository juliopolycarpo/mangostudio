/**
 * The two things `gh pr create` needs that neither the caller nor `gh` supplies.
 *
 * Both are reads against the machine the chat is pinned to, which is why they
 * are here rather than in the application layer: one runs `git`, the other
 * reads a file, and both have to happen on the runtime rather than on the hub.
 */

import { getRuntimeClient } from '../../../services/runtime-client';
import { runGit } from '../../git/infrastructure/git-cli';
import type { GhRuntimeSelection } from './gh-cli';

/** Where a repository keeps the body GitHub pre-fills a pull request with. */
const PR_TEMPLATE_PATH = '.github/pull_request_template.md';

/** Enough of the template to fill a body; a longer one is a repository problem. */
const PR_TEMPLATE_MAX_LINES = 400;

export interface PullRequestInputSource {
  readonly workdir: string;
  readonly selection: GhRuntimeSelection;
  readonly signal?: AbortSignal;
}

/**
 * The branch `--head` must name.
 *
 * `gh pr create` documents that when the current branch is not fully pushed it
 * prompts for where to push — and the runner sets `GH_PROMPT_DISABLED=1`, so
 * that prompt is a hang or a failure rather than a question. Naming the head
 * branch explicitly is what skips the whole forking-and-pushing path; pushing
 * first belongs to the caller.
 *
 * @example
 * const head = await readCurrentBranch({ workdir, selection });
 */
export async function readCurrentBranch(source: PullRequestInputSource): Promise<string> {
  const result = await runGit(['branch', '--show-current'], {
    cwd: source.workdir,
    ...source.selection,
    ...(source.signal ? { signal: source.signal } : {}),
  });
  const branch = result.stdout.trim();
  if (branch.length === 0) {
    throw new TypeError('The working tree has no current branch to open a pull request from.');
  }
  return branch;
}

/**
 * The repository's pull request template, or an empty string when it has none.
 *
 * Read rather than passed to gh as `--template`: that flag supplies *starting
 * body text for the interactive editor* and does not combine with a
 * non-interactive `--body`, so the only way a template reaches a
 * prompt-disabled `gh pr create` is as body text the hub assembled itself.
 *
 * A missing template is the normal case for most repositories, so any failure
 * to read one is an empty body rather than a failed request.
 *
 * @example
 * const body = caller.body ?? (await readPullRequestTemplate(source, chatId));
 */
export async function readPullRequestTemplate(
  source: PullRequestInputSource,
  chatId: string
): Promise<string> {
  try {
    const runtime = await getRuntimeClient(source.selection.userId, source.selection.environmentId);
    const result = await runtime.fs.readFile(
      {
        chatId,
        inputPath: PR_TEMPLATE_PATH,
        // Joined with the target's own separator: the workdir is a path on that
        // machine, which may not be the platform the hub is running on.
        resolvedPath: runtime.paths.join(source.workdir, PR_TEMPLATE_PATH),
        startLine: 1,
        maxLines: PR_TEMPLATE_MAX_LINES,
      },
      source.signal ? { signal: source.signal } : {}
    );
    return result.content;
  } catch {
    return '';
  }
}
