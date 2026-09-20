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
 */

/** A fully valid file: both tokens present, current schema version. */
export const VALID_CREDENTIALS_JSON = JSON.stringify({
  schemaVersion: 1,
  pairingToken: 'mrt_selector.valid',
  serveToken: 'srv_selector.valid',
});

/** Well-formed JSON holding neither credential — the shape a fresh slot writes. */
export const EMPTY_CREDENTIALS_JSON = '{}';

/** Truncated mid-object: `JSON.parse` throws before any field is seen. */
export const INVALID_JSON_CREDENTIALS = '{ "schemaVersion": 1, "pairingToken": ';

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

export type RuntimeCredentialsFixtureCase =
  | 'missing'
  | 'empty'
  | 'invalidJson'
  | 'futureSchema'
  | 'numericToken'
  | 'objectToken'
  | 'valid'
  | 'malformedSibling';

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
   * that could not tell the two apart would be the thing requirement 5 rules
   * out.
   */
  readonly errorSubstring: string | null;
  /**
   * Whether `writePairingToken`/`writeServeToken` may replace this file
   * outright. `false` for `futureSchema`, which must instead throw
   * `RuntimeCredentialsRefusedError`. This fixture set has no case for an
   * unreadable file (permission-denied has no portable byte content to
   * freeze), but that case refuses the same way — see
   * `runtime-home.test.ts`'s "reports a config it cannot open" test for the
   * `EISDIR` stand-in this suite uses for it.
   */
  readonly mayReplaceOnWrite: boolean;
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
    mayReplaceOnWrite: true,
  },
  // Present but wrong — missing the required `schemaVersion` — so unlike
  // `missing` this must carry a diagnostic, not a silent null.
  empty: {
    raw: EMPTY_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    mayReplaceOnWrite: true,
  },
  invalidJson: {
    raw: INVALID_JSON_CREDENTIALS,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'is not valid JSON',
    mayReplaceOnWrite: true,
  },
  futureSchema: {
    raw: FUTURE_SCHEMA_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'schemaVersion 2',
    mayReplaceOnWrite: false,
  },
  numericToken: {
    raw: NUMERIC_TOKEN_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    mayReplaceOnWrite: true,
  },
  objectToken: {
    raw: OBJECT_TOKEN_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    mayReplaceOnWrite: true,
  },
  valid: {
    raw: VALID_CREDENTIALS_JSON,
    readsPairingToken: 'mrt_selector.valid',
    readsServeToken: 'srv_selector.valid',
    errorSubstring: null,
    mayReplaceOnWrite: true,
  },
  // The whole document fails the schema check (`serveToken` is not a string),
  // so neither field is trusted for reading — not only the malformed one. A
  // write still must not carry the bad `serveToken` forward.
  malformedSibling: {
    raw: MALFORMED_SIBLING_CREDENTIALS_JSON,
    readsPairingToken: null,
    readsServeToken: null,
    errorSubstring: 'does not match the runtime credentials schema',
    mayReplaceOnWrite: true,
  },
};
