/**
 * What a runtime keeps on the machine it runs on.
 *
 * One file, `~/.mango/runtime/<slot>/runtime.json`, answers three questions a
 * hub cannot answer for itself: which bytes are installed here, who put them
 * there, and what their owner has agreed they may do. It is the only durable
 * state the trust boundary has — everything the protocol says about
 * capabilities is derived from it.
 *
 * **Nothing secret goes in this file.** It has to be safe to paste into a bug
 * report, so pairing and serve tokens live beside it in `credentials.json` at
 * 0600 instead. A reader that needs both opens both.
 *
 * Every field past the two identity ones is optional on disk, and the objects
 * accept keys they do not know. A runtime and a hub on different versions share
 * this file — a Windows hub provisions a distribution, then updates — so a
 * field written by a newer version must be ignored rather than fatal, and a
 * field a newer version expects must fall back to a documented default rather
 * than fail the read. A config a runtime cannot decode is a runtime that
 * refuses to start, which is the worst possible outcome for a machine reachable
 * only through the thing that will not start.
 */

import { type Static, Type } from '@sinclair/typebox';

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

export function isRuntimeSlot(value: string): value is RuntimeSlot {
  return (RUNTIME_SLOTS as readonly string[]).includes(value);
}

/** Where the bytes in this slot came from, which is what disambiguates `host`. */
export const RuntimeInstallSourceSchema = Type.Union([
  /** A release put it beside the hub executable. */
  Type.Literal('bundled'),
  /** A checkout runs the workspace entry through Bun; there is no binary. */
  Type.Literal('source-checkout'),
  /** A hub, an installer, or a person put it under the slot directory. */
  Type.Literal('provisioned'),
]);

export const RuntimePlatformIdSchema = Type.Union([
  Type.Literal('linux-x64'),
  Type.Literal('linux-arm64'),
  Type.Literal('linux-x64-musl'),
  Type.Literal('linux-arm64-musl'),
  Type.Literal('darwin-x64'),
  Type.Literal('darwin-arm64'),
]);
export type RuntimeInstallSource = Static<typeof RuntimeInstallSourceSchema>;

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
});
export type RuntimeCapabilityAllow = Static<typeof RuntimeCapabilityAllowSchema>;

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

/** Named presets over {@link RuntimeCapabilityAllowSchema}; `custom` is any other set. */
export const RuntimeConsentProfileSchema = Type.Union([
  Type.Literal('full'),
  Type.Literal('readonly'),
  Type.Literal('none'),
  Type.Literal('custom'),
]);
export type RuntimeConsentProfile = Static<typeof RuntimeConsentProfileSchema>;

/**
 * Whether anybody has answered the consent question for this slot yet.
 *
 * `pending` is a refusal to serve, not a degraded mode: a runtime someone else's
 * hub installed does nothing at all until an account on this machine says what
 * it may do.
 */
export const RuntimeSetupStateSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('configured'),
]);
export type RuntimeSetupState = Static<typeof RuntimeSetupStateSchema>;

/** Who answered, so a surprising `allow` set can be traced to an act. */
export const RuntimeSetupAuthoritySchema = Type.Union([
  /** Someone ran `mangostudio-runtime setup`. */
  Type.Literal('cli'),
  /** `MANGOSTUDIO_RUNTIME_SETUP`, which is how container images answer. */
  Type.Literal('env'),
  /** The act of starting this runtime by hand on this machine. */
  Type.Literal('launch'),
  /** An installer armed the gate without answering it. */
  Type.Literal('install'),
]);
export type RuntimeSetupAuthority = Static<typeof RuntimeSetupAuthoritySchema>;

export const RuntimeSetupRecordSchema = Type.Object({
  state: RuntimeSetupStateSchema,
  /** ISO-8601 instant the state was last written. */
  at: Type.Optional(Type.String({ maxLength: 64 })),
  by: Type.Optional(RuntimeSetupAuthoritySchema),
});
export type RuntimeSetupRecord = Static<typeof RuntimeSetupRecordSchema>;

/**
 * Which hub put these bytes here. Diagnostic only — nothing is authorised by
 * it, and a machine reachable from two hubs keeps whichever wrote last.
 */
export const RuntimeInstallerSchema = Type.Object({
  hubVersion: Type.Optional(Type.String({ maxLength: 64 })),
  host: Type.Optional(Type.String({ maxLength: 255 })),
  user: Type.Optional(Type.String({ maxLength: 255 })),
  transport: Type.Optional(Type.String({ maxLength: 32 })),
  at: Type.Optional(Type.String({ maxLength: 64 })),
});
export type RuntimeInstaller = Static<typeof RuntimeInstallerSchema>;

/**
 * Whether this slot records protocol calls to `audit.log`.
 *
 * Absent on disk takes the slot default: off for `host` (your machine, your
 * hub — pure noise), on for `wsl` and `remote` (every slot another machine's
 * hub reaches into). The log itself is local and never exposed on the wire.
 */
export const RuntimeAuditConfigSchema = Type.Object({
  enabled: Type.Boolean(),
});
export type RuntimeAuditConfig = Static<typeof RuntimeAuditConfigSchema>;

/** `sha256:<64 hex>` of the bytes an installer used. See `digest` below. */
export const RuntimeBinaryDigestSchema = Type.String({
  pattern: '^sha256:[a-f0-9]{64}$',
  maxLength: 71,
});

/**
 * `runtime.json` as it sits on disk.
 *
 * `schemaVersion` and `slot` are the only required fields, and a reader that
 * finds anything else missing takes the slot's default. See the module comment
 * for why the shape is this forgiving.
 */
export const RuntimeSlotConfigSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  slot: RuntimeSlotSchema,
  source: Type.Optional(RuntimeInstallSourceSchema),
  /** Version the installed bytes report, absent when nothing was installed here. */
  version: Type.Optional(Type.String({ maxLength: 64 })),
  /** Resolved path of the binary this slot's config describes. */
  binaryPath: Type.Optional(Type.String({ maxLength: 4_096 })),
  /**
   * Digest of the **source** an installer took these bytes from — the binary
   * itself when one was pushed whole, the archive it was extracted from when it
   * came out of a release.
   *
   * It answers one question: would this installer push something different from
   * what it pushed last time? That is what re-provisioning needs, and it is why
   * an archive digest is a correct answer rather than a sloppy one — the same
   * archive cannot yield a different member. It is deliberately *not* a
   * checksum of the file on disk, and nothing should verify one against it.
   *
   * It exists because version equality cannot see a rebuilt `dev` binary: two
   * different builds both report `dev`, so a hub comparing versions alone would
   * never re-push the one that changed.
   */
  digest: Type.Optional(RuntimeBinaryDigestSchema),
  /**
   * Source commit the installed bytes were built from, recorded only for a
   * rolling channel.
   *
   * A stable version identifies one build by itself. A rolling one does not:
   * `mangostudio-runtime-0.1.0-canary-linux-x64` is whatever the last green
   * commit published under that name, so without this field "which canary is
   * on this machine" has no answer that survives the filename collision.
   *
   * It is provenance, not a gate — nothing compares it to decide whether to
   * re-install. {@link digest} is what answers that.
   */
  sourceSha: Type.Optional(Type.String({ maxLength: 64 })),
  profile: Type.Optional(RuntimeConsentProfileSchema),
  allow: Type.Optional(Type.Partial(RuntimeCapabilityAllowSchema)),
  setup: Type.Optional(RuntimeSetupRecordSchema),
  installedBy: Type.Optional(RuntimeInstallerSchema),
  /**
   * Hub address `connect` dials, remembered so unattended restarts need no
   * flags. An address, not a credential — the token it pairs with is in
   * `credentials.json`.
   */
  hubUrl: Type.Optional(Type.String({ maxLength: 2_048 })),
  /**
   * Bind address `serve` uses when no `--listen` is passed — same shape as the
   * flag (`host:port` or a bare port for loopback). Remembered so a service
   * unit needs no flags beyond the subcommand.
   */
  serveListen: Type.Optional(Type.String({ maxLength: 256 })),
  /** Whether protocol calls are appended to this slot's `audit.log`. */
  audit: Type.Optional(RuntimeAuditConfigSchema),
});
export type RuntimeSlotConfig = Static<typeof RuntimeSlotConfigSchema>;

/**
 * `runtime.json` with every default filled in — what callers actually reason
 * about, and what `health` prints.
 */
export interface ResolvedRuntimeSlotConfig {
  readonly schemaVersion: number;
  readonly slot: RuntimeSlot;
  readonly source: RuntimeInstallSource;
  readonly version: string | null;
  readonly binaryPath: string | null;
  readonly digest: string | null;
  readonly sourceSha: string | null;
  readonly profile: RuntimeConsentProfile;
  readonly allow: RuntimeCapabilityAllow;
  readonly setup: RuntimeSetupRecord;
  readonly installedBy: RuntimeInstaller | null;
  readonly hubUrl: string | null;
  readonly serveListen: string | null;
  readonly audit: RuntimeAuditConfig;
}

/** Long-lived supervisor mode for the `remote` slot. */
export const RuntimeServiceModeSchema = Type.Union([
  Type.Literal('connect'),
  Type.Literal('serve'),
]);
export type RuntimeServiceMode = Static<typeof RuntimeServiceModeSchema>;

/**
 * `mangostudio-runtime service status --json` — stable shape for environment cards.
 */
export const RuntimeServiceStatusSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  platform: Type.Union([
    Type.Literal('linux'),
    Type.Literal('darwin'),
    Type.Literal('win32'),
    Type.Literal('unsupported'),
  ]),
  mode: Type.Union([RuntimeServiceModeSchema, Type.Null()]),
  installed: Type.Boolean(),
  enabled: Type.Boolean(),
  running: Type.Boolean(),
  /** Linux only: whether loginctl linger is on for this user. */
  linger: Type.Optional(Type.Boolean()),
  /** Whether the unit's ExecStart points at the slot `current` symlink. */
  execUsesCurrent: Type.Optional(Type.Boolean()),
  /**
   * Whether a binary is actually reachable through `current`. A unit can point
   * at the right path and still never start, which is the one failure the
   * manager's own states describe only as "not running".
   */
  currentBinaryPresent: Type.Optional(Type.Boolean()),
  /** Manager-specific detail (unit path, label, raw states). */
  manager: Type.Optional(
    Type.Object({
      unitPath: Type.Optional(Type.String({ maxLength: 4_096 })),
      label: Type.Optional(Type.String({ maxLength: 256 })),
      activeState: Type.Optional(Type.String({ maxLength: 64 })),
      subState: Type.Optional(Type.String({ maxLength: 64 })),
    })
  ),
  /** Set when status could not be fully determined. */
  error: Type.Optional(Type.String({ maxLength: 1_024 })),
});
export type RuntimeServiceStatus = Static<typeof RuntimeServiceStatusSchema>;

/**
 * What `health --json` prints and what the `runtime.health` protocol method
 * returns — one payload, so a terminal on the machine and a card in a browser
 * cannot disagree about what a runtime is allowed to do.
 */
export const RuntimeHealthReportSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  slot: RuntimeSlotSchema,
  source: RuntimeInstallSourceSchema,
  /** Version of the running process, which a stale config may not match. */
  runtimeVersion: Type.String({ maxLength: 64 }),
  version: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  binaryPath: Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()]),
  digest: Type.Union([RuntimeBinaryDigestSchema, Type.Null()]),
  /**
   * Source commit of a rolling build, echoed from `runtime.json`. Optional so a
   * hub still accepts health from a runtime that predates the field, and null
   * on every stable install, where the version already names the build.
   */
  sourceSha: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  profile: RuntimeConsentProfileSchema,
  allow: RuntimeCapabilityAllowSchema,
  setup: RuntimeSetupRecordSchema,
  platform: Type.String({ maxLength: 32 }),
  arch: Type.String({ maxLength: 32 }),
  /** Exact release asset identity, including the Linux libc variant. */
  platformId: Type.Optional(RuntimePlatformIdSchema),
  homeDir: Type.String({ maxLength: 4_096 }),
  /** Shells present on this machine, in the protocol's own vocabulary. */
  shells: Type.Array(Type.String({ maxLength: 32 })),
  git: Type.Object({
    available: Type.Boolean(),
    version: Type.Optional(Type.String({ maxLength: 64 })),
  }),
  /**
   * What went wrong reading the home, when something did. A `runtime.json` this
   * process could not parse is the case worth naming: silently treating it as
   * absent would turn a corrupt consent file into an open one.
   */
  lastError: Type.Union([Type.String({ maxLength: 1_024 }), Type.Null()]),
  /**
   * Whether this slot appends protocol calls to `audit.log`. Optional so a
   * hub on protocol 1.0 can still accept a health payload from a pre-audit
   * runtime peer — required would 500 the lifecycle view on mixed releases.
   */
  audit: Type.Optional(RuntimeAuditConfigSchema),
  /**
   * Set when the audit log was enabled but a recent write failed (full disk,
   * permissions). The runtime keeps serving; the receipt is what degraded.
   */
  auditError: Type.Optional(Type.Union([Type.String({ maxLength: 1_024 }), Type.Null()])),
});
export type RuntimeHealthReport = Static<typeof RuntimeHealthReportSchema>;
