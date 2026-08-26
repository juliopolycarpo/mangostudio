/**
 * The GraphQL documents this product is allowed to send through `gh api graphql`.
 *
 * `gh api` is the one GitHub CLI subcommand that can do anything the REST and
 * GraphQL APIs can do — `gh api repos/o/r -X DELETE` deletes a repository — so
 * the runtime never allowlists it bare. It accepts `api graphql` and nothing
 * else, and within that it accepts only a `-f query=` whose value is one of the
 * documents below.
 *
 * The membership check lives here, in shared, rather than being a string the
 * hub hands the runtime and the runtime takes on faith. A validator that
 * compares against whatever the caller supplied is theatre; a validator that
 * compares against a constant *both ends import* means the hub cannot ask for a
 * field this module did not ship, whatever the hub was talked into sending.
 *
 * Comparison is on a normalized form (trimmed, runs of whitespace collapsed to
 * one space) rather than byte-exact. The security property being defended is
 * "no field the hub did not ship can be requested", and re-indenting a document
 * does not touch a single field — while renaming, adding, or nesting one
 * changes a non-whitespace token and still fails. Normalizing lets a hub that
 * reflowed the string through a formatter keep working without weakening that.
 */

/**
 * A pull request's review threads with their resolution state.
 *
 * Two nullability facts from real responses, because a consumer that assumes
 * otherwise breaks on ordinary data rather than on an edge case: `line` is
 * `null` for an outdated thread — the diff moved out from under it — and
 * `author` is null for a comment whose account was deleted.
 */
export const GITHUB_PR_REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            nodes { author { login } body }
          }
        }
      }
    }
  }
}`;

/** Every document `gh api graphql` may be asked to run, in the order they were pinned. */
export const PINNED_GITHUB_GRAPHQL_DOCUMENTS: readonly string[] = Object.freeze([
  GITHUB_PR_REVIEW_THREADS_QUERY,
]);

const NORMALIZED_PINNED_DOCUMENTS: ReadonlySet<string> = new Set(
  PINNED_GITHUB_GRAPHQL_DOCUMENTS.map(normalizeGraphqlDocument)
);

/**
 * Whether a GraphQL document is one this product pinned.
 *
 * Both the hub-side caller and the runtime-side argument validator ask this, so
 * they agree by construction rather than by review.
 *
 * @example
 * isPinnedGithubGraphqlDocument(GITHUB_PR_REVIEW_THREADS_QUERY); // true
 * isPinnedGithubGraphqlDocument('query { viewer { login } }'); // false
 */
export function isPinnedGithubGraphqlDocument(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return NORMALIZED_PINNED_DOCUMENTS.has(normalizeGraphqlDocument(value));
}

/** Collapses insignificant layout so a reflowed document still matches its pin. */
function normalizeGraphqlDocument(document: string): string {
  return document.trim().replace(/\s+/g, ' ');
}
