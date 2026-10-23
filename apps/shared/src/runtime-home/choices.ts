import Type, { type Static } from 'typebox';

/**
 * Who placed the runtime in this directory — not which transport talks to it.
 *
 * One machine reachable by ssh *and* a dialled-in WebSocket shares one slot,
 * one consent file, and one binary. The distinction that matters for trust is
 * whose install put the bytes there: `host` and `wsl` are the work of somebody
 * with an account on this machine, `remote` is the work of somebody's hub.
 */
export const RuntimeSlotSchema = Type.Union([
  /** Shipped beside the hub binary by this machine's own install. */
  Type.Literal('host'),
  /** Pushed into a WSL distribution by a Windows hub. */
  Type.Literal('wsl'),
  /** Placed over ssh, or installed by hand for a WebSocket or Direct URL pair. */
  Type.Literal('remote'),
]);

export type RuntimeSlot = Static<typeof RuntimeSlotSchema>;

/** Every slot, in the order a report lists them. Derived, so it cannot drift. */
export const RUNTIME_SLOTS = RuntimeSlotSchema.anyOf.map(
  (member) => member.const
) as readonly RuntimeSlot[];

/**
 * The capabilities consent is expressed in.
 *
 * Feature-level, deliberately: per-tool lists read as precision they cannot
 * deliver, because one shell tool reaches everything the account can. The split
 * that earns its keep is read from write — `fsRead` without `fsWrite` is a
 * runtime that can be inspected but not changed, and that is a configuration
 * people actually want.
 */
export const RuntimeCapabilityAllowSchema = Type.Object({
  fsRead: Type.Boolean(),
  fsWrite: Type.Boolean(),
  /** Grants everything a shell can reach. See {@link SHELL_TRUST_NOTICE}. */
  shell: Type.Boolean(),
  git: Type.Boolean(),
  probing: Type.Boolean(),
  mcp: Type.Boolean(),
  library: Type.Boolean(),
  checkpoints: Type.Boolean(),
  /** Whether a hub may replace these bytes with a version it offers. */
  update: Type.Boolean(),
  /**
   * Whether this runtime may launch vendor-owned agent processes. Optional on
   * disk for old files; resolution treats absence as false, never as consent.
   */
  externalAgents: Type.Optional(Type.Boolean()),
});

export type RuntimeCapabilityAllow = Static<typeof RuntimeCapabilityAllowSchema>;

/** Consent after disk defaults are applied; privileged external-agent consent is always explicit. */
export type ResolvedRuntimeCapabilityAllow = Omit<RuntimeCapabilityAllow, 'externalAgents'> & {
  readonly externalAgents: boolean;
};

/**
 * The one sentence every consent surface has to say, in the CLI that writes
 * consent and in the UI that displays it.
 *
 * It lives here rather than in a comment because it is the difference between a
 * user choosing `full` knowingly and choosing it because the word sounded
 * routine. A hub with `allow.shell` can run anything the account running the
 * runtime can run; the capability list below it is a description of the
 * intended surface, not a sandbox.
 */
export const SHELL_TRUST_NOTICE =
  'Allowing shell gives the hub everything this account can run. Only "readonly" meaningfully limits what a hub can do here.';
