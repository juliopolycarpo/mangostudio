/**
 * Self-update contract: who owns the installed binary, whether a newer release
 * exists, and how an upgrade in progress reports itself. One shape feeds
 * `mangostudio upgrade --json`, `mangostudio status`, `GET /api/machine/update`
 * and the SSE stream behind `POST /api/machine/upgrade`, so the terminal and the
 * "This machine" page cannot disagree.
 */

import type { Static } from 'typebox';
import Type from 'typebox';
import { SSEErrorEventSchema } from '../errors';

/** Release channel a build came from or an upgrade targets. */
export const UpdateChannelSchema = Type.Union([Type.Literal('stable'), Type.Literal('canary')]);
export type UpdateChannel = Static<typeof UpdateChannelSchema>;

/**
 * Which tool owns the installed binary, i.e. which one must replace it.
 * `self-managed` is the installer-script layout the hub can upgrade on its own;
 * every other value is a package manager or a deployment the hub must not fight.
 */
export const InstallManagerSchema = Type.Union([
  Type.Literal('self-managed'),
  Type.Literal('npm'),
  Type.Literal('bun'),
  Type.Literal('pnpm'),
  Type.Literal('homebrew'),
  Type.Literal('scoop'),
  Type.Literal('cargo'),
  Type.Literal('docker'),
  Type.Literal('source'),
  Type.Literal('unknown'),
]);
export type InstallManager = Static<typeof InstallManagerSchema>;

export const INSTALLED_VIA_PATH_MAX = 4_096;

/** How the running binary was installed, as far as the hub can tell. */
export const InstalledViaSchema = Type.Object({
  manager: InstallManagerSchema,
  channel: UpdateChannelSchema,
  /** Real path of the running executable, symlinks resolved. */
  executable: Type.String({ maxLength: INSTALLED_VIA_PATH_MAX }),
  /** `self-managed` only: the root holding the side-by-side version directories. */
  distRoot: Type.Optional(Type.String({ maxLength: INSTALLED_VIA_PATH_MAX })),
  /** `self-managed` root written before `install-origin.json` existed; migrated on the next install. */
  legacy: Type.Optional(Type.Boolean()),
  /** The wrapper that launched this process, when a launcher announced itself. */
  launcherPath: Type.Optional(Type.String({ maxLength: INSTALLED_VIA_PATH_MAX })),
});
export type InstalledVia = Static<typeof InstalledViaSchema>;

export const UPDATE_VERSION_MAX = 128;
export const UPDATE_ERROR_MAX = 1_024;

/**
 * The last answer from the release host. `latestVersion` is absent when the
 * check could not complete; `error` then says why, so a stale cache is never
 * mistaken for "up to date".
 */
export const UpdateCheckSchema = Type.Object({
  channel: UpdateChannelSchema,
  currentVersion: Type.String({ maxLength: UPDATE_VERSION_MAX }),
  latestVersion: Type.Optional(Type.String({ maxLength: UPDATE_VERSION_MAX })),
  /** Canary only: the source commit the rolling pre-release currently carries. */
  latestSourceSha: Type.Optional(Type.String({ maxLength: 64 })),
  updateAvailable: Type.Boolean(),
  /** Epoch milliseconds of the check that produced this answer. */
  checkedAt: Type.Integer({ minimum: 0 }),
  error: Type.Optional(Type.String({ maxLength: UPDATE_ERROR_MAX })),
});
export type UpdateCheck = Static<typeof UpdateCheckSchema>;

/**
 * Why the hub will not upgrade itself. Each one comes with the command that
 * does the job instead, so the refusal is a redirection rather than a dead end.
 */
export const UpgradeRefusalReasonSchema = Type.Union([
  /** `getVersion()` is `dev`: rebuild from the checkout. */
  Type.Literal('source-checkout'),
  /** Running in a container: pull the image tag instead. */
  Type.Literal('container'),
  /** A package manager owns the binary and offers this channel. */
  Type.Literal('package-manager'),
  /** A package manager owns the binary but has no build on this channel. */
  Type.Literal('channel-unsupported'),
  /** No launcher marker, no origin record, no recognisable path. */
  Type.Literal('unknown-origin'),
  /** The channel and platform have no published source (musl per-sha canary). */
  Type.Literal('unsupported-target'),
  /** Windows: the process that must be replaced is the one asking. */
  Type.Literal('windows-service'),
  /** Another upgrade is already running from this hub. */
  Type.Literal('in-progress'),
]);
export type UpgradeRefusalReason = Static<typeof UpgradeRefusalReasonSchema>;

export const UPGRADE_COMMAND_MAX = 512;

/** `GET /api/machine/update`: the banner's whole input. */
export const MachineUpdateStatusSchema = Type.Object({
  installedVia: InstalledViaSchema,
  /** Null when checks are disabled or none has run yet. */
  check: Type.Union([UpdateCheckSchema, Type.Null()]),
  /** Whether `[updates] check` is on for this hub. */
  checksEnabled: Type.Boolean(),
  /** Whether `POST /api/machine/upgrade` can act from this process. */
  canUpgrade: Type.Boolean(),
  reason: Type.Optional(UpgradeRefusalReasonSchema),
  /** What upgrades this install: the manager's own command, or `mangostudio upgrade`. */
  command: Type.Optional(Type.String({ maxLength: UPGRADE_COMMAND_MAX })),
});
export type MachineUpdateStatus = Static<typeof MachineUpdateStatusSchema>;

export const UPGRADE_SHA_PATTERN = '^[0-9a-f]{7,40}$';

/** `POST /api/machine/upgrade` body. No channel means the build's own. */
export const MachineUpgradeBodySchema = Type.Object(
  {
    channel: Type.Optional(UpdateChannelSchema),
    /** Stable only: an exact version instead of the latest. */
    version: Type.Optional(Type.String({ maxLength: UPDATE_VERSION_MAX })),
    /** Canary only: a source commit instead of the rolling latest. */
    sha: Type.Optional(Type.String({ pattern: UPGRADE_SHA_PATTERN })),
    /** Restart the hub once the pointer has moved. Defaults to true. */
    restart: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);
export type MachineUpgradeBody = Static<typeof MachineUpgradeBodySchema>;

/** Where the download came from and what checked it. */
export const UpgradeSourceKindSchema = Type.Union([
  Type.Literal('archive'),
  Type.Literal('npm-tarball'),
]);
export type UpgradeSourceKind = Static<typeof UpgradeSourceKindSchema>;

export const UpgradeVerificationSchema = Type.Union([
  /** SHA-256 from the release's `SHA256SUMS`. */
  Type.Literal('sha256-sums'),
  /** sha512 `dist.integrity` from the npm registry. */
  Type.Literal('npm-integrity'),
]);
export type UpgradeVerification = Static<typeof UpgradeVerificationSchema>;

/** What `upgrade` resolved before touching the disk. */
export const UpgradeTargetSchema = Type.Object({
  channel: UpdateChannelSchema,
  version: Type.String({ maxLength: UPDATE_VERSION_MAX }),
  sourceSha: Type.Optional(Type.String({ maxLength: 64 })),
  assetName: Type.String({ maxLength: 256 }),
  url: Type.String({ maxLength: 2_048 }),
  kind: UpgradeSourceKindSchema,
  verification: UpgradeVerificationSchema,
});
export type UpgradeTarget = Static<typeof UpgradeTargetSchema>;

export const UpgradeStageSchema = Type.Union([
  Type.Literal('resolve'),
  Type.Literal('download'),
  Type.Literal('verify'),
  Type.Literal('install'),
  Type.Literal('restart'),
]);
export type UpgradeStage = Static<typeof UpgradeStageSchema>;

export const UPGRADE_OUTPUT_LINE_MAX = 8_192;

export const UpgradeStageEventSchema = Type.Object({
  type: Type.Literal('stage'),
  stage: UpgradeStageSchema,
  detail: Type.Optional(Type.String({ maxLength: UPDATE_ERROR_MAX })),
  done: Type.Literal(false),
});
export type UpgradeStageEvent = Static<typeof UpgradeStageEventSchema>;

/** One line of the install script's output, relayed verbatim. */
export const UpgradeOutputEventSchema = Type.Object({
  type: Type.Literal('output'),
  stream: Type.Union([Type.Literal('stdout'), Type.Literal('stderr')]),
  line: Type.String({ maxLength: UPGRADE_OUTPUT_LINE_MAX }),
  done: Type.Literal(false),
});
export type UpgradeOutputEvent = Static<typeof UpgradeOutputEventSchema>;

export const UpgradeOutcomeSchema = Type.Union([
  Type.Literal('upgraded'),
  Type.Literal('already-current'),
  /** `--check`: a newer build exists, named on `target`; nothing was downloaded. */
  Type.Literal('available'),
  /** The hub would not act; `command` names what to run instead. */
  Type.Literal('refused'),
  /** Download, verification or the script failed; nothing was published. */
  Type.Literal('failed'),
]);
export type UpgradeOutcome = Static<typeof UpgradeOutcomeSchema>;

/** What happened to the running hub after the pointer moved. */
export const UpgradeRestartSchema = Type.Union([
  Type.Literal('scheduled'),
  Type.Literal('not-running'),
  Type.Literal('skipped'),
  /** Foreground hub: the terminal that owns it has to restart it. */
  Type.Literal('manual'),
]);
export type UpgradeRestart = Static<typeof UpgradeRestartSchema>;

/**
 * The upgrade's final word. Also the `--json` document `mangostudio upgrade`
 * prints, minus `type`/`done`. `exitCode` follows the CLI contract: 0 done,
 * already current, or a `--check` preview (available or not), 1 refused, 2
 * download, verification or script failure.
 */
export const UpgradeReportSchema = Type.Object({
  outcome: UpgradeOutcomeSchema,
  installedVia: InstalledViaSchema,
  currentVersion: Type.String({ maxLength: UPDATE_VERSION_MAX }),
  target: Type.Optional(UpgradeTargetSchema),
  reason: Type.Optional(UpgradeRefusalReasonSchema),
  command: Type.Optional(Type.String({ maxLength: UPGRADE_COMMAND_MAX })),
  restart: Type.Optional(UpgradeRestartSchema),
  /** Windows delegations: where the detached waiter writes the manager's output. */
  logFile: Type.Optional(Type.String({ maxLength: INSTALLED_VIA_PATH_MAX })),
  message: Type.Optional(Type.String({ maxLength: UPDATE_ERROR_MAX })),
  exitCode: Type.Integer({ minimum: 0, maximum: 2 }),
});
export type UpgradeReport = Static<typeof UpgradeReportSchema>;

export const UpgradeDoneEventSchema = Type.Intersect([
  Type.Object({ type: Type.Literal('done'), done: Type.Literal(true) }),
  UpgradeReportSchema,
]);
export type UpgradeDoneEvent = Static<typeof UpgradeDoneEventSchema>;

export const UpgradeStreamEventSchema = Type.Union([
  UpgradeStageEventSchema,
  UpgradeOutputEventSchema,
  UpgradeDoneEventSchema,
  SSEErrorEventSchema,
]);
export type UpgradeStreamEvent = Static<typeof UpgradeStreamEventSchema>;
