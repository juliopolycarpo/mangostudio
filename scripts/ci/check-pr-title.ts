#!/usr/bin/env bun
// A pull request title is a commit subject. Check that git-cliff will file it.
//
// A squash merge takes its subject from the PR title, and cliff.toml sets
// `filter_unconventional = true` and groups commits only by the types its
// `commit_parsers` name. A title with any other type lands on main and drops out of
// CHANGELOG.md and the release notes without a warning (#2398 landed as
// `hardening(protocol): ...` and its entry is missing).
//
// The allowed types are read from cliff.toml, never repeated here, so what a contributor
// is told to use and what the changelog groups cannot drift apart.
//
// Dependency-free (Bun built-ins only): the workflow runs the base branch's copy before
// any install. Usage: bun ./scripts/ci/check-pr-title.ts "feat(api): add a thing"
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIFF_TOML_PATH = join(import.meta.dir, '..', '..', 'cliff.toml');

// A parser that groups a whole type is exactly `^<type>`. Anything longer, like
// `^chore\(deps\)`, narrows a type that a plain parser already groups, so it adds nothing.
const WHOLE_TYPE_PATTERN = /^\^([a-z]+)$/;

// `type`, optional `(scope)`, optional `!`, then a colon and one space before the summary.
// The type is captured loosely so an unknown one is named in the failure instead of
// being reported as a malformed subject. A scope may hold inner spaces (`feat(api, db)`),
// never a paren, and never starts or ends with whitespace.
const SUBJECT_PATTERN =
  /^(?<type>[A-Za-z][\w-]*)(?:\((?<scope>[^()\s](?:[^()]*[^()\s])?)\))?(?<breaking>!)?: (?<summary>\S.*)$/;

interface CommitParser {
  readonly message?: unknown;
  readonly skip?: unknown;
}

/**
 * The commit types cliff.toml groups, in file order.
 *
 * Skip parsers (`^chore\(release\)`) drop commits rather than group them, so they never
 * count. Scope-narrowed parsers (`^build\(deps\)`) and the body catch-all that files
 * the rest under "Other" are not types either.
 * @example
 * allowedTypesFromCliff('[git]\ncommit_parsers = [{ message = "^feat", group = "x" }]');
 * // ['feat']
 */
export function allowedTypesFromCliff(cliffToml: string): string[] {
  const config = Bun.TOML.parse(cliffToml) as { git?: { commit_parsers?: CommitParser[] } };
  const parsers = config.git?.commit_parsers;
  if (!Array.isArray(parsers)) {
    const received = parsers === undefined ? 'no commit_parsers' : typeof parsers;
    throw new Error(
      `cliff.toml: expected [git] commit_parsers as an array | received: ${received}`
    );
  }
  const types = new Set<string>();
  for (const parser of parsers) {
    if (parser.skip === true || typeof parser.message !== 'string') continue;
    const type = WHOLE_TYPE_PATTERN.exec(parser.message)?.[1];
    if (type !== undefined) types.add(type);
  }
  if (types.size === 0) {
    throw new Error(
      "cliff.toml: expected commit_parsers with a '^<type>' message pattern | received: none"
    );
  }
  return [...types];
}

/**
 * Why a title cannot be a changelog-bearing commit subject, or `null` when it can.
 * @example
 * checkPrTitle('feat(api): add a thing', ['feat']); // null
 * checkPrTitle('hardening: add a thing', ['feat']); // "unknown type 'hardening'..."
 */
export function checkPrTitle(title: string, allowedTypes: readonly string[]): string | null {
  const shape = `expected: type(scope): summary or type: summary, with an optional ! before the colon
  types: ${allowedTypes.join(', ')}`;
  const fail = (reason: string): string =>
    `${reason}\nreceived: ${JSON.stringify(title)}\n${shape}`;

  if (title !== title.trim()) {
    return fail('the title starts or ends with whitespace');
  }
  const match = SUBJECT_PATTERN.exec(title);
  if (match?.groups === undefined) {
    return fail('the title is not a Conventional Commit subject (missing type, colon or summary)');
  }
  const { type } = match.groups;
  if (type === undefined || !allowedTypes.includes(type)) {
    return fail(`unknown type '${type}', which git-cliff would not group`);
  }
  return null;
}

if (import.meta.main) {
  const title = process.argv[2];
  if (process.argv.length !== 3 || title === undefined || title === '') {
    console.error(
      `check-pr-title: expected exactly one non-empty title argument | received: ${JSON.stringify(process.argv.slice(2))}`
    );
    process.exit(2);
  }
  try {
    const failure = checkPrTitle(
      title,
      allowedTypesFromCliff(readFileSync(CLIFF_TOML_PATH, 'utf8'))
    );
    if (failure !== null) {
      console.error(`check-pr-title: ${failure}`);
      process.exit(1);
    }
    console.log(`check-pr-title: ok: ${title}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
