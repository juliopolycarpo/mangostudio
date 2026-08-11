/**
 * What the vendored Codex contract was generated from, and what a live binary
 * must be for it to apply.
 *
 * Two different versions live here on purpose.
 *
 * `CODEX_PROTOCOL_PACKAGE` is the **regeneration** pin. It names a published
 * npm tarball by version and integrity digest, and it exists so that
 * `bun run vendor-contracts:regen` produces byte-identical output on any machine
 * — including a CI runner with no Codex installed at all. It is never a launch
 * path: nothing in the adapter shells out to `bunx`, and a user whose `codex`
 * came from npm, from Bun, from Homebrew or from a downloaded binary is served
 * by the same vendored types.
 *
 * `MINIMUM_CODEX_VERSION` is the **runtime** gate. It is compared against
 * whatever `codex --version` reports from the executable the runtime scanner
 * actually resolved. Older than this and `openSession` fails with a typed
 * error, because the contract in `protocol/` describes methods that binary does
 * not serve. Newer is allowed: `app-server` is additive in practice, unknown
 * notifications are ignored by construction, and locking users out of an
 * upgrade they installed themselves would be a worse failure than the drift the
 * regeneration check already reports.
 */

/** The npm package the vendored contract in `protocol/` was generated from. */
export const CODEX_PROTOCOL_PACKAGE = {
  name: '@openai/codex',
  version: '0.147.0',
  /** `dist.integrity` for this exact tarball, as published to the npm registry. */
  integrity:
    'sha512-EQLEXecAG2ptxI7UpBMo2TR/ga5596/c/OsYF/0LoUDh5JANZ7IoGqlzBEWbuEVQ76JePIbtTW/ihCkp1a7Z3w==',
} as const;

/** Exactly what the regeneration script and its CI drift check invoke. */
export const CODEX_PROTOCOL_PACKAGE_SPEC =
  `${CODEX_PROTOCOL_PACKAGE.name}@${CODEX_PROTOCOL_PACKAGE.version}` as const;

/**
 * The oldest `codex` this adapter will drive.
 *
 * Equal to the generated version because that is the only build the contract
 * has been observed against. Lowering it is a decision that needs a probe, not
 * an optimistic guess about what an older `app-server` accepted.
 */
export const MINIMUM_CODEX_VERSION = '0.147.0' as const;

/** The command that signs a user in, shown with a copy button when signed out. */
export const CODEX_LOGIN_COMMAND = 'codex login' as const;

/**
 * Notification families this client asks the server never to send.
 *
 * Every name here is one MangoStudio would drop anyway, so opting out narrows
 * the parse surface and the attack surface together rather than discarding
 * anything the UI could have shown. `thread/realtime/*` is audio, `app/*` and
 * `plugin/*` are the desktop app's own surfaces, `remoteControl/*` is a
 * separate control channel, and `mcpServer/startupStatus/updated` fires once
 * per configured server on every single thread start.
 *
 * The vendor matches these **exactly** — there is no wildcard — so each member
 * of a family is listed individually and
 * `tests/unit/services/codex-protocol-pin.test.ts` asserts the list still
 * covers every matching method name in the generated `ServerNotification`
 * union. A family that grows a member on a version bump fails that test rather
 * than silently starting to arrive.
 */
export const CODEX_OPT_OUT_NOTIFICATION_PREFIXES: readonly string[] = [
  'thread/realtime/',
  'app/',
  'plugin/',
  'remoteControl/',
];

/** Individually named opt-outs that belong to no family above. */
export const CODEX_OPT_OUT_NOTIFICATION_METHODS: readonly string[] = [
  'mcpServer/startupStatus/updated',
];
