/** Canonical error code constants shared across API and frontend. */
export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  NOT_A_DIRECTORY: 'NOT_A_DIRECTORY',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  GENERATION_EMPTY: 'GENERATION_EMPTY',
  OWNERSHIP: 'OWNERSHIP',
  RATE_LIMITED: 'RATE_LIMITED',
  UNSUPPORTED: 'UNSUPPORTED',
  CHATGPT_REAUTH_REQUIRED: 'CHATGPT_REAUTH_REQUIRED',
  NOTHING_TO_COMMIT: 'NOTHING_TO_COMMIT',
  AMEND_WITHOUT_HEAD: 'AMEND_WITHOUT_HEAD',
  SIGNING_FAILED: 'SIGNING_FAILED',
  STASH_CONFLICT: 'STASH_CONFLICT',
  CHECKOUT_BLOCKED: 'CHECKOUT_BLOCKED',
  BRANCH_NOT_MERGED: 'BRANCH_NOT_MERGED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NON_FAST_FORWARD: 'NON_FAST_FORWARD',
  HISTORY_DIVERGED: 'HISTORY_DIVERGED',
  GIT_LOCKED: 'GIT_LOCKED',
  GIT_COMMAND_FAILED: 'GIT_COMMAND_FAILED',
  /**
   * A library removal would leave no copy of a resource anywhere and the
   * request did not name it in `acknowledgeLastCopy`. Distinct from a plain
   * validation failure because the fix is the user's, not the client's.
   */
  LAST_COPY_UNACKNOWLEDGED: 'LAST_COPY_UNACKNOWLEDGED',
  /** The request carried a valid API key, but the owner has not enabled the external API. */
  EXTERNAL_API_DISABLED: 'EXTERNAL_API_DISABLED',
  /** An API key attempted an operation its scope or credential policy forbids. */
  API_KEY_SCOPE_FORBIDDEN: 'API_KEY_SCOPE_FORBIDDEN',
  /** The account already owns the maximum number of active API keys. */
  API_KEY_LIMIT_REACHED: 'API_KEY_LIMIT_REACHED',
  /**
   * An external agent would load third-party configuration out of a workspace
   * the user has not yet agreed to trust. Distinct from a plain permission
   * failure because the fix is one explicit choice, not a settings change.
   */
  EXTERNAL_WORKSPACE_UNTRUSTED: 'EXTERNAL_WORKSPACE_UNTRUSTED',
  /**
   * The machine an external agent would run on has not proved that vendor
   * logins belong to the MangoStudio user whose turn it is.
   *
   * Its own code because nothing the user can do in MangoStudio fixes it: the
   * remedy is a per-user OS account, a per-user container or a single-user hub,
   * which is an operator's change. A generic permission error would send people
   * looking through their own settings for a switch that does not exist.
   */
  EXTERNAL_ISOLATION_UNPROVEN: 'EXTERNAL_ISOLATION_UNPROVEN',
  /**
   * The user has not acknowledged this vendor's third-party disclosure, or has
   * acknowledged a materially different one. Distinct from a validation failure
   * because the request is well-formed and the fix is one explicit choice.
   */
  EXTERNAL_DISCLOSURE_REQUIRED: 'EXTERNAL_DISCLOSURE_REQUIRED',
  /**
   * Another MangoStudio chat already holds the native vendor session this
   * request tried to adopt.
   *
   * Its own code because the remedy is neither a retry nor a refresh: one
   * vendor session has one transcript, and the way out is to use the chat that
   * already has it — or to let that chat's lease expire.
   */
  EXTERNAL_SESSION_HELD: 'EXTERNAL_SESSION_HELD',
  /**
   * A native review was asked for on a workspace that is not a Git repository.
   *
   * MangoStudio's own precondition, not the vendor's: Codex runs the review
   * anyway and logs `fatal: not a git repository` internally, so a review of
   * uncommitted changes outside a repository would complete having reviewed
   * nothing. Its own code because the remedy is neither a retry nor a setting —
   * it is initializing a repository, or pointing the chat somewhere else.
   */
  EXTERNAL_REVIEW_REQUIRES_GIT: 'EXTERNAL_REVIEW_REQUIRES_GIT',
  /**
   * The turn named a model whose provider MangoStudio no longer offers.
   *
   * Its own code rather than a generic provider failure because nothing about
   * the request or the connector is broken — the ownership model changed, and
   * the way forward is a different model or the vendor's own CLI. The refusal
   * carries `ModelUnavailableDetails` so the client can render that choice
   * instead of an apology.
   */
  MODEL_PROVIDER_DEPRECATED: 'MODEL_PROVIDER_DEPRECATED',
  /** The hub's `[terminal] enabled` is off; the panel is hidden and opens are refused. */
  TERMINAL_DISABLED: 'TERMINAL_DISABLED',
  /** The user already holds the configured number of running terminal sessions. */
  TERMINAL_LIMIT: 'TERMINAL_LIMIT',
  /**
   * A terminal on the Local runtime — the hub's own OS account — was asked for
   * on a hub with more than one user. Its own code for the same reason
   * `EXTERNAL_ISOLATION_UNPROVEN` has one: the remedy is an operator's, not a
   * setting the user can find.
   */
  TERMINAL_NOT_ISOLATED: 'TERMINAL_NOT_ISOLATED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
