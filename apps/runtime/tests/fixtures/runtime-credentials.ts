/**
 * Every shape `~/.mango/runtime/<slot>/credentials.json` can be found in on
 * disk, named so a second implementation of `runtime-home.ts` — the planned
 * Rust rewrite of this layer — can drive the same cases without reading this
 * repository's TypeScript, only these bytes.
 *
 * Each `*_JSON` constant is the file's raw text, verbatim, the same way
 * `legacy-hello-1-0-1.ts` freezes wire bytes elsewhere in this suite: copy the
 * string, not an assertion built on top of it. `RUNTIME_CREDENTIALS_FIXTURES`
 * is the decision table `apps/runtime/src/runtime-home.ts` settled for #1060 —
 * case name, the bytes (or `null` for "no file at all"), what
 * `readPairingToken`/`readServeToken` may trust from it, what diagnostic
 * `readRuntimeSlotCredentialsState` reports, and whether
 * `writePairingToken`/`writeServeToken` may replace it outright. See
 * `readRuntimeSlotCredentialsState` and `requireReplaceableCredentials` for
 * the code this table describes.
 *
 * Every case here is one this process can produce or discover on its own
 * (tampering, truncation, a foreign schema version); it is not a claim that
 * every conceivable byte sequence has a fixture.
 */

/** A fully valid file: both tokens present, current schema version. */
export const VALID_CREDENTIALS_JSON = JSON.stringify({
  schemaVersion: 1,
  pairingToken: 'mrt_selector.valid',
  serveToken: 'srv_selector.valid',
});

/**
 * Well-formed JSON holding neither credential. Nothing in this codebase ever
 * writes this shape — the writers always set `schemaVersion` — so on disk
 * this is what tampering or a truncated copy looks like, not a shape a fresh
 * slot produces itself (a fresh slot has no file at all; see `missing`).
 */
export const EMPTY_CREDENTIALS_JSON = '{}';

/** Truncated mid-object: `JSON.parse` throws before any field is seen. */
export const INVALID_JSON_CREDENTIALS = '{ "schemaVersion": 1, "pairingToken": ';

/**
 * Truncated immediately after a token value, rather than before one. Guards
 * the same invariant `INVALID_JSON_CREDENTIALS` does — the diagnostic for
 * invalid JSON is a fixed string, never the parser's own message — for the
 * specific shape where a leak would be a whole token rather than a fragment.
 */
export const TRUNCATED_AFTER_TOKEN_CREDENTIALS_JSON =
  '{ "schemaVersion": 1, "pairingToken": "mrt_selector.truncated';

/** Valid JSON that is not an object at all: the schema check must reject it, not throw on it. */
export const NULL_DOCUMENT_CREDENTIALS_JSON = 'null';

/** Same as `NULL_DOCUMENT_CREDENTIALS_JSON`, for the array shape of "not an object". */
export const ARRAY_DOCUMENT_CREDENTIALS_JSON = '[]';

/**
 * A `schemaVersion` this build has never heard of. The one shape that must
 * never be silently replaced: a future runtime may have put fields here this
 * build cannot name, and overwriting them with `schemaVersion: 1` would be
 * the exact downgrade #1060 reported.
 */
export const FUTURE_SCHEMA_CREDENTIALS_JSON = JSON.stringify({
  schemaVersion: 2,
  pairingToken: 'mrt_selector.future',
});

/** A pairing token stored as a number instead of a string. */
export const NUMERIC_TOKEN_CREDENTIALS_JSON = JSON.stringify({
  schemaVersion: 1,
  pairingToken: 42,
});

/** A serve token stored as an object instead of a string. */
export const OBJECT_TOKEN_CREDENTIALS_JSON = JSON.stringify({
  schemaVersion: 1,
  serveToken: { nested: true },
});

/**
 * A valid pairing token sitting beside a malformed serve token. Proves the
 * malformed sibling is never carried forward by a write to the *other* field —
 * the bug #1060 reported was exactly this value surviving a
 * `writePairingToken`/`writeServeToken` merge as if it had validated.
 */
export const MALFORMED_SIBLING_CREDENTIALS_JSON = JSON.stringify({
  schemaVersion: 1,
  pairingToken: 'mrt_selector.good',
  serveToken: 12345,
});

/**
 * A valid document at the current schema version carrying a field this
 * build's schema does not name. TypeBox objects are additive-permissive, so
 * this validates and reads exactly like `VALID_CREDENTIALS_JSON` — the fixture
 * exists for the write side: `refreshToken` must survive a
 * `writePairingToken`/`writeServeToken` rotation, the same invariant
 * `mergeRuntimeSlotConfig` already holds for `runtime.json`.
 */
export const EXTRA_FIELD_CREDENTIALS_JSON = JSON.stringify({
  schemaVersion: 1,
  pairingToken: 'mrt_selector.extra',
  refreshToken: 'rft_keepme',
});

export type RuntimeCredentialsFixtureCase =
  | 'missing'
  | 'empty'
  | 'invalidJson'
  | 'truncatedAfterToken'
  | 'nullDocument'
  | 'arrayDocument'
  | 'futureSchema'
  | 'numericToken'
  | 'objectToken'
  | 'valid'
  | 'malformedSibling'
  | 'extraField';

export interface RuntimeCredentialsFixture {
  /** The file's exact bytes, or `null` when the case is "no file at all". */
  readonly raw: string | null;
  /** What `readPairingToken` must return for this file. */
  readonly readsPairingToken: string | null;
  /** What `readServeToken` must return for this file. */
  readonly readsServeToken: string | null;
  /**
   * A substring `readRuntimeSlotCredentialsState(...).error` must contain, or
   * `null` when it must be exactly `null` (absent or fully valid). Distinct
   * from `readsPairingToken`/`readsServeToken` on purpose: `missing` and
   * `empty` both read as "no tokens", but only `missing` is silent about it —
   * `empty` is present and still wrong (no `schemaVersion`), and a diagnostic
   * that could not tell the two apart would defeat the point of having one.
   */
  readonly errorSubstring: string | null;
  /**
   * Token-shaped substrings this fixture's raw bytes carry that must never
   * appear in `error`. Kept separate from `errorSubstring` because a leak is
   * about a *value*, not the diagnostic's own wording — `errorSubstring`
   * checks the message says the right thing, this checks it never quotes a
   * secret while saying it.
   */
  readonly tokensToNeverLeak: readonly string[];
  /**
   * `readRuntimeSlotCredentialsState(...).kind` for this file: `usable` reads
   * its tokens outright, `replaceable` reads none but
   * `writePairingToken`/`writeServeToken` may discard it, `refused` reads
   * none and a write throws `RuntimeCredentialsRefusedError` instead. This
   * fixture set has no case for an unreadable file (permission-denied has no
   * portable byte content to freeze) but that case is `refused` too — see
   * `runtime-credentials-validation.test.ts`'s "refuses to replace a file it
   * could not read" test for the `EISDIR` stand-in this suite uses for it.
   */
  readonly kind: 'usable' | 'replaceable' | 'refused';
}

/** The full case → outcome table this defect fix settled. */
export const RUNTIME_CREDENTIALS_FIXTURES: Readonly<
  Record<RuntimeCredentialsFixtureCase, RuntimeCredentialsFixture>
> = {
  missing: {
    raw: null,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: null,
    tokensToNeverLeak: [],
    kind: 'usable',
  },
  // Present but wrong — missing the required `schemaVersion` — so unlike
  // `missing` this must carry a diagnostic, not a silent null.
  empty: {
    raw: EMPTY_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    tokensToNeverLeak: [],
    kind: 'replaceable',
  },
  invalidJson: {
    raw: INVALID_JSON_CREDENTIALS,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'is not valid JSON',
    tokensToNeverLeak: [],
    kind: 'replaceable',
  },
  truncatedAfterToken: {
    raw: TRUNCATED_AFTER_TOKEN_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'is not valid JSON',
    tokensToNeverLeak: ['mrt_selector.truncated'],
    kind: 'replaceable',
  },
  nullDocument: {
    raw: NULL_DOCUMENT_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    tokensToNeverLeak: [],
    kind: 'replaceable',
  },
  arrayDocument: {
    raw: ARRAY_DOCUMENT_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    tokensToNeverLeak: [],
    kind: 'replaceable',
  },
  futureSchema: {
    raw: FUTURE_SCHEMA_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'schemaVersion 2',
    tokensToNeverLeak: ['mrt_selector.future'],
    kind: 'refused',
  },
  numericToken: {
    raw: NUMERIC_TOKEN_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    tokensToNeverLeak: ['42'],
    kind: 'replaceable',
  },
  objectToken: {
    raw: OBJECT_TOKEN_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    tokensToNeverLeak: ['nested'],
    kind: 'replaceable',
  },
  valid: {
    raw: VALID_CREDENTIALS_JSON,
    readsPairingToken: 'mrt_selector.valid',
    readsServeToken: 'srv_selector.valid',
    errorSubstring: null,
    tokensToNeverLeak: [],
    kind: 'usable',
  },
  // The whole document fails the schema check (`serveToken` is not a string),
  // so neither field is trusted for reading — not only the malformed one. A
  // write still must not carry the bad `serveToken` forward.
  malformedSibling: {
    raw: MALFORMED_SIBLING_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    tokensToNeverLeak: ['mrt_selector.good', '12345'],
    kind: 'replaceable',
  },
  // Valid and additive: reads exactly like `valid`. Its own assertion lives
  // in `runtime-credentials-validation.test.ts` ("preserves a field a newer
  // build wrote"), not this table — the table only sees single-write reads,
  // and the invariant this fixture proves is about a *second* write.
  extraField: {
    raw: EXTRA_FIELD_CREDENTIALS_JSON,
    readsPairingToken: 'mrt_selector.extra',
    readsServeToken: null,
    errorSubstring: null,
    tokensToNeverLeak: [],
    kind: 'usable',
  },
};
