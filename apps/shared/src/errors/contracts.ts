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
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
