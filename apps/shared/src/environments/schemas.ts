import Type, { type Static } from 'typebox';
import { ApiErrorResponseSchema, SSEErrorEventSchema } from '../errors';
import {
  LibraryLocationStatusSchema,
  LibraryTargetIdSchema,
  MAX_DIRECTORY_HASH_DOMAIN_VERSION,
} from '../library';
import { ProfileIdSchema } from '../profiles';
import { RuntimeCapabilityAllowSchema, RuntimeHealthReportSchema } from '../runtime-home/schemas';
import {
  RuntimeCapabilityManifestSchema,
  RuntimeErrorCodeSchema,
} from '../runtime-protocol/schemas';
import { ReadonlyArraySchema } from '../schema-helpers';

export const LOCAL_ENVIRONMENT_ID = 'local' as const;

/**
 * Name the hub reports for the machine it runs on. Not user copy: it is the
 * environment's name in the API the same way a remote's stored name is, and
 * surfaces that render it inside a translated sentence resolve it from
 * {@link LOCAL_ENVIRONMENT_ID} through i18n instead of printing this.
 */
export const LOCAL_ENVIRONMENT_NAME = 'Local' as const;

export const EnvironmentIdSchema = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
});

export const EnvironmentTransportKindSchema = Type.Union([
  Type.Literal('in-process'),
  Type.Literal('stdio'),
  Type.Literal('wsl'),
  Type.Literal('websocket'),
  Type.Literal('http'),
  Type.Literal('ssh'),
  Type.Literal('container'),
]);

export const InProcessEnvironmentConfigSchema = Type.Object(
  {},
  { additionalProperties: Type.Never() }
);

export const StdioEnvironmentConfigSchema = Type.Object(
  {
    binaryPath: Type.Optional(Type.String({ minLength: 1 })),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: Type.Never() }
);

export const WslEnvironmentConfigSchema = Type.Object(
  {
    distro: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: Type.Never() }
);

export const WebSocketEnvironmentConfigSchema = Type.Object(
  {},
  { additionalProperties: Type.Never() }
);

export const HttpEnvironmentConfigSchema = Type.Object(
  {
    baseUrl: Type.String({
      minLength: 1,
      maxLength: 2_048,
      pattern: '^https?://',
    }),
  },
  { additionalProperties: Type.Never() }
);

const SshArgumentValueSchema = Type.String({
  minLength: 1,
  maxLength: 1_024,
  pattern: '^[^-].*$',
});

export const SshEnvironmentConfigSchema = Type.Object(
  {
    host: SshArgumentValueSchema,
    user: Type.Optional(SshArgumentValueSchema),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
    identityFile: Type.Optional(SshArgumentValueSchema),
    remoteRuntimePath: Type.Optional(SshArgumentValueSchema),
  },
  { additionalProperties: Type.Never() }
);

/**
 * Which container engine runs the image. It selects a binary name and nothing
 * else: every flag this transport passes is accepted by both CLIs, and the
 * moment one of them needs its own argv the union stops being a name and
 * becomes a fork nobody signed up for.
 */
export const ContainerEngineSchema = Type.Union([Type.Literal('docker'), Type.Literal('podman')]);

/**
 * A host path the agent can see inside the container.
 *
 * Absolute on both sides because a relative path is resolved by whichever
 * process the engine happens to inherit a working directory from. Colons are
 * refused (they separate the three fields of `-v`) except for a Windows drive
 * prefix, which the engines parse themselves.
 */
export const ContainerMountSchema = Type.Object(
  {
    hostPath: Type.String({ minLength: 1, maxLength: 1_024, pattern: '^[^-]' }),
    containerPath: Type.String({ minLength: 1, maxLength: 1_024, pattern: '^/[^\\s:]*$' }),
    readonly: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: Type.Never() }
);

/**
 * How many mounts one environment may declare.
 *
 * A bound rather than a policy: each entry is an argv pair the hub constructs,
 * and an unbounded list is an unbounded command line. Eight is well past what
 * "the project, and maybe its cache" needs.
 */
export const CONTAINER_MAX_MOUNTS = 8;

/**
 * An image the hub starts a runtime inside, and the limits it starts it with.
 *
 * The image is the user's, never ours: nothing is baked and nothing is
 * published. The runtime binary is bind-mounted read-only at launch, so an
 * upgrade follows the hub with no image rebuild.
 *
 * `cpus` and `memoryMib` are engine limits, not isolation guarantees — they
 * bound what a runaway agent consumes, and no copy should present them as part
 * of the sandbox boundary.
 */
export const ContainerEnvironmentConfigSchema = Type.Object(
  {
    /**
     * A reference the engine can resolve: `[registry/]name[:tag][@digest]`.
     * The character class refuses whitespace and a leading dash, so an image
     * can never arrive at the engine as an option.
     */
    image: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._/:@-]*$',
    }),
    engine: Type.Optional(ContainerEngineSchema),
    /**
     * Whether the container gets a network. On by default because agents clone,
     * fetch and install; off is one flag (`--network none`) and one toggle.
     */
    network: Type.Optional(Type.Boolean()),
    cpus: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1_024 })),
    memoryMib: Type.Optional(Type.Integer({ minimum: 64, maximum: 1_048_576 })),
    mounts: Type.Optional(Type.Array(ContainerMountSchema, { maxItems: CONTAINER_MAX_MOUNTS })),
  },
  { additionalProperties: Type.Never() }
);

/**
 * Why a container launch failed, when the engine's output allows naming it.
 *
 * Same reason SSH carries one: these arrive as one exit status and one
 * `RUNTIME_UNAVAILABLE`, while the fixes have nothing to do with each other —
 * a missing engine is installed, an unreachable daemon is started, an image
 * without a shell is swapped for one that has it.
 */
export const ContainerFailureReasonSchema = Type.Union([
  /** No `docker`/`podman` on the hub's PATH. */
  Type.Literal('engine-missing'),
  /** The CLI is there; the daemon is down, or this user may not talk to it. */
  Type.Literal('engine-unreachable'),
  /** The registry has no such image, or refuses this hub's (absent) credentials. */
  Type.Literal('image-missing'),
  /** The pull started and did not finish: network, registry error, rate limit. */
  Type.Literal('image-pull-failed'),
  /** No shell to probe with, or an architecture no runtime is built for. */
  Type.Literal('image-unsupported'),
  /** The hub could not produce a runtime binary matching the image's platform. */
  Type.Literal('runtime-unavailable'),
  Type.Literal('unknown'),
]);

/**
 * Whether this machine can run containers at all, and with which engines.
 *
 * Answered hub-side for the same reason WSL detection is: the environments it
 * would describe do not exist yet, so there is no runtime to ask. Linux
 * containers only — Windows containers are out of scope, and Docker Desktop on
 * a Windows or macOS hub is a supported host, so nothing here is
 * platform-gated.
 */
export const ContainerEngineStatusSchema = Type.Object(
  {
    engine: ContainerEngineSchema,
    /** True when the CLI is on PATH *and* answered a version query. */
    available: Type.Boolean(),
    /** What the CLI reported, when it answered. */
    version: Type.Optional(Type.String({ maxLength: 128 })),
    /** Why it did not, so the dialog can say "start Docker" rather than "no engine". */
    reason: Type.Optional(ContainerFailureReasonSchema),
  },
  { additionalProperties: false }
);

export const ContainerDetectionSchema = Type.Object(
  {
    /** True when at least one engine answered. */
    available: Type.Boolean(),
    engines: Type.Array(ContainerEngineStatusSchema),
  },
  { additionalProperties: false }
);

/**
 * Why an SSH launch failed, as far as the client's own output allows.
 *
 * `ssh` reports every failure of its own — auth, host key, timeout, DNS — as
 * exit 255 and passes a remote command's code through otherwise, so the reason
 * lives in stderr rather than in the exit status. It reaches the card because
 * the fixes are unrelated to each other: a refused host key is answered by
 * connecting once by hand, a missing binary by installing one there.
 */
export const SshFailureReasonSchema = Type.Union([
  /** No `ssh` on the hub's PATH. */
  Type.Literal('client-missing'),
  Type.Literal('auth-refused'),
  Type.Literal('host-key-unverified'),
  /** DNS, timeout, refused, unroutable — the host never answered. */
  Type.Literal('unreachable'),
  Type.Literal('runtime-missing'),
  Type.Literal('runtime-not-executable'),
  /** The runtime is there and refuses to serve until its owner runs `setup`. */
  Type.Literal('setup-pending'),
  Type.Literal('unknown'),
]);

/**
 * A distribution `wsl.exe -l -v` reported. `state` is passed through as the
 * Windows shell printed it: that column is localized, so mapping it to an enum
 * would either lie on a non-English host or drop the information entirely.
 */
export const WslDistributionSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    state: Type.String({ maxLength: 64 }),
    wslVersion: Type.Integer({ minimum: 1, maximum: 9 }),
    default: Type.Boolean(),
    /** Set when an environment is already configured for this distribution. */
    environmentId: Type.Optional(EnvironmentIdSchema),
  },
  { additionalProperties: false }
);

export const WslUnavailableReasonSchema = Type.Union([
  Type.Literal('not-windows'),
  Type.Literal('wsl-not-installed'),
  Type.Literal('probe-failed'),
]);

export const WslDetectionSchema = Type.Object(
  {
    available: Type.Boolean(),
    distributions: Type.Array(WslDistributionSchema),
    reason: Type.Optional(WslUnavailableReasonSchema),
  },
  { additionalProperties: false }
);

export const EnvironmentTransportConfigSchema = Type.Union([
  Type.Object(
    {
      transportKind: Type.Literal('in-process'),
      config: InProcessEnvironmentConfigSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      transportKind: Type.Literal('stdio'),
      config: StdioEnvironmentConfigSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      transportKind: Type.Literal('wsl'),
      config: WslEnvironmentConfigSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      transportKind: Type.Literal('websocket'),
      config: WebSocketEnvironmentConfigSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      transportKind: Type.Literal('http'),
      config: HttpEnvironmentConfigSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      transportKind: Type.Literal('ssh'),
      config: SshEnvironmentConfigSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      transportKind: Type.Literal('container'),
      config: ContainerEnvironmentConfigSchema,
    },
    { additionalProperties: false }
  ),
]);

export const CreateEnvironmentBodySchema = Type.Union([
  Type.Object(
    {
      id: EnvironmentIdSchema,
      name: Type.String({ minLength: 1, maxLength: 80 }),
      transportKind: Type.Literal('stdio'),
      config: StdioEnvironmentConfigSchema,
      enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      id: EnvironmentIdSchema,
      name: Type.String({ minLength: 1, maxLength: 80 }),
      transportKind: Type.Literal('wsl'),
      config: WslEnvironmentConfigSchema,
      enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      id: EnvironmentIdSchema,
      name: Type.String({ minLength: 1, maxLength: 80 }),
      transportKind: Type.Literal('websocket'),
      config: WebSocketEnvironmentConfigSchema,
      enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      id: EnvironmentIdSchema,
      name: Type.String({ minLength: 1, maxLength: 80 }),
      transportKind: Type.Literal('http'),
      config: HttpEnvironmentConfigSchema,
      /** Write-only; stored in the OS secret store, never returned. */
      token: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
      enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      id: EnvironmentIdSchema,
      name: Type.String({ minLength: 1, maxLength: 80 }),
      transportKind: Type.Literal('ssh'),
      config: SshEnvironmentConfigSchema,
      enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      id: EnvironmentIdSchema,
      name: Type.String({ minLength: 1, maxLength: 80 }),
      transportKind: Type.Literal('container'),
      config: ContainerEnvironmentConfigSchema,
      enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false }
  ),
]);

export const UpdateEnvironmentBodySchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    config: Type.Optional(Type.Unknown()),
    enabled: Type.Optional(Type.Boolean()),
    allowInstalls: Type.Optional(Type.Boolean()),
    /** Write-only Direct URL token; rejected on non-http transports. */
    token: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  },
  { additionalProperties: false, minProperties: 1 }
);

export const EnvironmentConnectionStateSchema = Type.Union([
  Type.Literal('disconnected'),
  Type.Literal('connecting'),
  Type.Literal('connected'),
  Type.Literal('error'),
]);

export const EnvironmentConnectionStatusSchema = Type.Object(
  {
    state: EnvironmentConnectionStateSchema,
    manifest: Type.Optional(RuntimeCapabilityManifestSchema),
    errorCode: Type.Optional(RuntimeErrorCodeSchema),
    /**
     * Release the connected runtime reported in its handshake, absent until
     * one has. It matters because remote transports deliberately do not gate
     * on release equality: a runtime installed on someone else's machine can
     * lag the hub, and drift that is allowed has to be readable somewhere or
     * an operator has no way to tell an outdated binary from a healthy one.
     */
    runtimeVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /**
     * Whether that release differs from the hub's. Decided here rather than in
     * the client because only the hub knows both strings, and shipping its own
     * version on every row to let the UI compare would repeat one constant N
     * times to answer one question.
     */
    runtimeVersionDrift: Type.Optional(Type.Boolean()),
    /**
     * Set when an SSH launch failed and the client's output named a cause.
     * `errorCode` cannot carry it: every one of these arrives as
     * `RUNTIME_UNAVAILABLE`, and they have nothing to do with each other.
     */
    sshFailureReason: Type.Optional(SshFailureReasonSchema),
    /** The same, for a container launch. See {@link ContainerFailureReasonSchema}. */
    containerFailureReason: Type.Optional(ContainerFailureReasonSchema),
    /**
     * Set while a container image is being fetched, before anything can start
     * inside it. A cold pull of a large image runs for minutes, and `connecting`
     * alone would report that as a hub that has stopped responding rather than
     * as a download with an end.
     */
    pullingImage: Type.Optional(Type.Boolean()),
    /**
     * Set while the hub is swapping this runtime's binary over its own
     * connection. A live update ends with a deliberate disconnect, and without
     * this the card would report the handoff as an outage — the one state where
     * `disconnected` is the expected, healthy answer.
     */
    updating: Type.Optional(Type.Boolean()),
    /**
     * Set when this launch used a runtime the hub had cached but could not
     * confirm against the release, because the release could not be reached.
     *
     * The bytes were verified once, against a digest recorded at download time,
     * so this is not an unverified runtime — it is one nothing re-checked this
     * session. Reported because the alternative to reporting it is a hub that
     * silently stops noticing it has been offline for weeks.
     */
    offlineRuntimeCache: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export const EnvironmentSchema = Type.Object(
  {
    id: EnvironmentIdSchema,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    transportKind: EnvironmentTransportKindSchema,
    config: Type.Unknown(),
    enabled: Type.Boolean(),
    /**
     * Whether install recipes may run on this machine. Off until its owner
     * says otherwise: the loopback guard that protects the hub's own machine
     * proves nothing about anyone else's, and inheriting its verdict would
     * silently extend a local-only permission across the network.
     */
    allowInstalls: Type.Boolean(),
    virtual: Type.Boolean(),
    createdAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    updatedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    status: EnvironmentConnectionStatusSchema,
    /** Present for Direct URL environments; true when a token is in the secret store. */
    hasRuntimeToken: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export const EnvironmentListSchema = Type.Array(EnvironmentSchema);

/**
 * A machine credential for one dial-in environment. The secret half is never
 * part of this shape: it exists once, in the issue response, and is stored
 * hashed from then on.
 */
export const RuntimePairingTokenSchema = Type.Object(
  {
    environmentId: EnvironmentIdSchema,
    createdAt: Type.Integer({ minimum: 0 }),
    /** Last time the runtime authenticated with it; throttled to minutes. */
    lastSeenAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false }
);

// Heritage folding drops a member's own `additionalProperties`, so this schema
// accepts unknown keys — the behavior `Type.Composite` already had here. Fixing
// it would change a public contract, so it stays a recorded finding.
export const RuntimePairingIssueSchema = Type.Interface([RuntimePairingTokenSchema], {
  /** Readable exactly once. Regenerating is the only way to see one again. */
  token: Type.String({ minLength: 1 }),
});

export const RuntimePairingStatusSchema = Type.Object(
  {
    /**
     * The `wss://…/api/runtime` address a runtime dials, derived from
     * `server.publicUrl`. Null when the hub has not been told how peers reach
     * it — a request header would be a guess, and a spoofable one.
     */
    endpoint: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    token: Type.Union([RuntimePairingTokenSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

export type RuntimePairingToken = Static<typeof RuntimePairingTokenSchema>;
export type RuntimePairingIssue = Static<typeof RuntimePairingIssueSchema>;
export type RuntimePairingStatus = Static<typeof RuntimePairingStatusSchema>;

export type EnvironmentId = Static<typeof EnvironmentIdSchema>;
export type EnvironmentTransportKind = Static<typeof EnvironmentTransportKindSchema>;
export type InProcessEnvironmentConfig = Static<typeof InProcessEnvironmentConfigSchema>;
export type StdioEnvironmentConfig = Static<typeof StdioEnvironmentConfigSchema>;
export type WslEnvironmentConfig = Static<typeof WslEnvironmentConfigSchema>;
export type WebSocketEnvironmentConfig = Static<typeof WebSocketEnvironmentConfigSchema>;
export type HttpEnvironmentConfig = Static<typeof HttpEnvironmentConfigSchema>;
export type SshEnvironmentConfig = Static<typeof SshEnvironmentConfigSchema>;
export type SshFailureReason = Static<typeof SshFailureReasonSchema>;
export type ContainerEngine = Static<typeof ContainerEngineSchema>;
export type ContainerMount = Static<typeof ContainerMountSchema>;
export type ContainerEnvironmentConfig = Static<typeof ContainerEnvironmentConfigSchema>;
export type ContainerFailureReason = Static<typeof ContainerFailureReasonSchema>;
export type ContainerEngineStatus = Static<typeof ContainerEngineStatusSchema>;
export type ContainerDetection = Static<typeof ContainerDetectionSchema>;
export type WslDistribution = Static<typeof WslDistributionSchema>;
export type WslUnavailableReason = Static<typeof WslUnavailableReasonSchema>;
export type WslDetection = Static<typeof WslDetectionSchema>;
export type EnvironmentTransportConfig = Static<typeof EnvironmentTransportConfigSchema>;
export type CreateEnvironmentBody = Static<typeof CreateEnvironmentBodySchema>;
export type UpdateEnvironmentBody = Static<typeof UpdateEnvironmentBodySchema>;
export type EnvironmentConnectionState = Static<typeof EnvironmentConnectionStateSchema>;
export type EnvironmentConnectionStatus = Static<typeof EnvironmentConnectionStatusSchema>;
export type Environment = Static<typeof EnvironmentSchema>;

export const RuntimeIdSchema = Type.Union([
  Type.Literal('bun'),
  Type.Literal('node'),
  Type.Literal('nvm'),
  Type.Literal('mangostudio'),
  Type.Literal('claude'),
  Type.Literal('codex'),
  Type.Literal('cursor'),
]);

export const RuntimeOriginSchema = Type.Union([
  Type.Literal('path'),
  Type.Literal('well-known'),
  Type.Literal('version-manager'),
  Type.Literal('configured'),
]);

export const VersionManagerIdSchema = Type.Union([
  Type.Literal('nvm'),
  Type.Literal('fnm'),
  Type.Literal('volta'),
]);

export const LtsStatusSchema = Type.Union([
  Type.Literal('current-lts'),
  Type.Literal('lts-outdated-patch'),
  Type.Literal('lts-superseded'),
  Type.Literal('end-of-life'),
  Type.Literal('current-release'),
  Type.Literal('unknown'),
]);

export const RuntimeHealthSchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('warn'),
  Type.Literal('missing'),
  Type.Literal('error'),
]);

export const RuntimeFindingCodeSchema = Type.Union([
  Type.Literal('not-found'),
  Type.Literal('installed-but-not-on-path'),
  Type.Literal('shadowed-by-earlier-path'),
  Type.Literal('multiple-versions'),
  Type.Literal('version-below-minimum'),
  Type.Literal('version-below-minimum-for'),
  Type.Literal('not-executable'),
  Type.Literal('outdated-lts'),
  Type.Literal('managed-but-not-on-path'),
  Type.Literal('probe-timeout'),
  Type.Literal('cli-not-installed'),
  Type.Literal('config-home-missing'),
  Type.Literal('not-authenticated'),
  Type.Literal('version-probe-failed'),
  Type.Literal('location-unwritable'),
]);

/**
 * `warn` escalates the owning status's `health`; `info` is detail a card can
 * still list but that never moves the badge. Absent means `warn` — every
 * finding predating this field escalated unconditionally, so an old caller
 * that never sets it keeps that behavior.
 */
export const RuntimeFindingSeveritySchema = Type.Union([
  Type.Literal('warn'),
  Type.Literal('info'),
]);

export const AgentAuthSignalSchema = Type.Union([
  Type.Literal('file-present'),
  Type.Literal('file-absent'),
  Type.Literal('config-key-present'),
  /** The config that would carry the key is not there. Distinct from a config that lacks it. */
  Type.Literal('config-key-absent'),
  Type.Literal('session'),
  Type.Literal('unknown'),
]);

export const RuntimeInstallationSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  rawPath: Type.String({ minLength: 1 }),
  /** `null` when the binary executed but its output did not parse as a version. */
  version: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  origin: RuntimeOriginSchema,
  pathIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  effective: Type.Boolean(),
  aliasOf: Type.Optional(Type.String({ minLength: 1 })),
  managedBy: Type.Optional(VersionManagerIdSchema),
});

export const RuntimeFindingSchema = Type.Object({
  code: RuntimeFindingCodeSchema,
  params: Type.Optional(Type.Record(Type.String(), Type.String())),
  severity: Type.Optional(RuntimeFindingSeveritySchema),
});

export const RuntimeStatusSchema = Type.Object({
  id: RuntimeIdSchema,
  health: RuntimeHealthSchema,
  installations: Type.Array(RuntimeInstallationSchema),
  effective: Type.Optional(RuntimeInstallationSchema),
  findings: Type.Array(RuntimeFindingSchema),
  installable: Type.Boolean(),
  probedAtMs: Type.Number({ minimum: 0 }),
});

export const RuntimeStatusListSchema = Type.Array(RuntimeStatusSchema);

export const AgentCliStatusSchema = Type.Interface([RuntimeStatusSchema], {
  targetId: LibraryTargetIdSchema,
  configHome: Type.String({ minLength: 1 }),
  configHomeExists: Type.Boolean(),
  authenticated: Type.Boolean(),
  authSignal: AgentAuthSignalSchema,
  locations: Type.Array(LibraryLocationStatusSchema),
});

export const AgentCliStatusListSchema = Type.Array(AgentCliStatusSchema);

export const ManagedVersionSchema = Type.Object({
  version: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  isDefault: Type.Boolean(),
  isCurrent: Type.Boolean(),
  ltsStatus: LtsStatusSchema,
  ltsCodename: Type.Optional(Type.String({ minLength: 1 })),
});

export const VersionManagerStatusSchema = Type.Object({
  id: VersionManagerIdSchema,
  installed: Type.Boolean(),
  root: Type.Optional(Type.String({ minLength: 1 })),
  managerVersion: Type.Optional(Type.String({ minLength: 1 })),
  versions: Type.Array(ManagedVersionSchema),
  defaultAlias: Type.Optional(Type.String({ minLength: 1 })),
  defaultVersion: Type.Optional(Type.String({ minLength: 1 })),
  currentVersion: Type.Optional(Type.String({ minLength: 1 })),
  findings: Type.Array(RuntimeFindingSchema),
});

export const VersionManagerStatusListSchema = Type.Array(VersionManagerStatusSchema);

export const InstallRecipeIdSchema = Type.Union([
  Type.Literal('bun.install.official'),
  Type.Literal('bun.update'),
  Type.Literal('nvm.install'),
  Type.Literal('nvm.node.install'),
  Type.Literal('nvm.node.set-default'),
  Type.Literal('claude.install'),
  Type.Literal('codex.install'),
  Type.Literal('cursor.install'),
]);

export const InstallActionSchema = Type.Union([
  Type.Literal('install'),
  Type.Literal('update'),
  Type.Literal('use-version'),
  Type.Literal('set-default'),
]);

export const InstallPlatformSchema = Type.Union([Type.Literal('darwin'), Type.Literal('linux')]);

export const NodeVersionSpecSchema = Type.String({
  minLength: 1,
  maxLength: 32,
  pattern: '^(?:lts|latest|\\d+(?:\\.\\d+){0,2})$',
});

export const RecipeInputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('none'),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal('node-version'),
      version: NodeVersionSpecSchema,
    },
    { additionalProperties: false }
  ),
]);

export const InstallGuardReasonSchema = Type.Union([
  Type.Literal('container'),
  Type.Literal('server-not-loopback'),
  Type.Literal('client-not-loopback'),
  Type.Literal('disabled'),
  /**
   * The environment has not been trusted with installs. Distinct from
   * `disabled`, which is the global switch: a refusal has to name which side
   * said no, or the person flipping settings cannot tell which one to flip.
   */
  Type.Literal('environment-not-trusted'),
  /**
   * The connected machine's consent refuses shell, which every install recipe
   * needs. Distinct from trust: the environment may be trusted and still deny
   * the capability that would run the installer.
   */
  Type.Literal('runtime-denied'),
]);

export const InstallGuardSchema = Type.Object({
  allowed: Type.Boolean(),
  reasons: Type.Array(InstallGuardReasonSchema),
});

export const InstallRecipeDownloadSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  sizeBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  sha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
});

export const InstallProfileSetupSchema = Type.Object({
  lines: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  present: Type.Boolean(),
  detectedIn: Type.Array(Type.String({ minLength: 1 })),
});

export const InstallRecipePreviewSchema = Type.Object({
  id: InstallRecipeIdSchema,
  runtimeId: RuntimeIdSchema,
  action: InstallActionSchema,
  inputKind: Type.Union([Type.Literal('none'), Type.Literal('node-version')]),
  platforms: Type.Array(InstallPlatformSchema),
  argv: Type.Array(Type.String()),
  copyCommand: Type.String({ minLength: 1 }),
  requires: Type.Array(RuntimeIdSchema),
  writes: Type.Array(Type.String()),
  networkAccess: Type.Boolean(),
  timeoutMs: Type.Integer({ minimum: 1 }),
  supported: Type.Boolean(),
  missingRequirements: Type.Array(RuntimeIdSchema),
  guard: InstallGuardSchema,
  download: Type.Optional(InstallRecipeDownloadSchema),
  profileSetup: Type.Optional(InstallProfileSetupSchema),
});

export const InstallPrepareBodySchema = Type.Object(
  {
    recipeId: InstallRecipeIdSchema,
    input: RecipeInputSchema,
    /** Which machine to install on; the hub's own unless a caller says otherwise. */
    environmentId: Type.Optional(EnvironmentIdSchema),
    /** Reserved: profiles are not selectable yet. Omitted requests use the active profile. */
    profileId: Type.Optional(ProfileIdSchema),
  },
  { additionalProperties: false }
);

export const InstallPreparationSchema = Type.Object({
  preparationId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  expiresAt: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  recipe: InstallRecipePreviewSchema,
});

export const InstallStartBodySchema = Type.Object(
  {
    recipeId: InstallRecipeIdSchema,
    input: RecipeInputSchema,
    /** Which machine to install on; the hub's own unless a caller says otherwise. */
    environmentId: Type.Optional(EnvironmentIdSchema),
    preparationId: Type.Optional(Type.String({ minLength: 1 })),
    /** Reserved: profiles are not selectable yet. Omitted requests use the active profile. */
    profileId: Type.Optional(ProfileIdSchema),
  },
  { additionalProperties: false }
);

export const InstallStartResponseSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  attached: Type.Boolean(),
});

export const InstallCancelResponseSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  cancellationRequested: Type.Boolean(),
});

export const InstallBlockedResponseSchema = Type.Interface([ApiErrorResponseSchema], {
  recipe: InstallRecipePreviewSchema,
});

export const InstallRunStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('timed-out'),
  Type.Literal('spawn-failed'),
  /**
   * The server stopped while the installer was running. The installer may have
   * completed, partially completed, or never finished — the outcome is unknown
   * and is deliberately not reported as a failure.
   */
  Type.Literal('interrupted'),
]);

export const InstallRunSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  recipeId: InstallRecipeIdSchema,
  argv: Type.Array(Type.String()),
  startedAt: Type.Number({ minimum: 0 }),
  finishedAt: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  status: InstallRunStatusSchema,
  truncated: Type.Boolean(),
});

export const InstallRunListSchema = Type.Array(InstallRunSchema);

export const InstallLogEventSchema = Type.Object({
  type: Type.Literal('log'),
  stream: Type.Union([Type.Literal('stdout'), Type.Literal('stderr'), Type.Literal('system')]),
  line: Type.String(),
  done: Type.Literal(false),
});

export const InstallProbeEventSchema = Type.Object({
  type: Type.Literal('probe'),
  target: Type.Union([
    Type.Literal('runtime'),
    Type.Literal('version-manager'),
    Type.Literal('agent'),
  ]),
  status: Type.Union([RuntimeStatusSchema, VersionManagerStatusSchema, AgentCliStatusSchema]),
  done: Type.Literal(false),
});

export const InstallExitEventSchema = Type.Object({
  type: Type.Literal('exit'),
  code: Type.Union([Type.Integer(), Type.Null()]),
  status: Type.Exclude(InstallRunStatusSchema, Type.Literal('running')),
  truncated: Type.Boolean(),
  durationMs: Type.Number({ minimum: 0 }),
  done: Type.Literal(true),
});

export const InstallStreamEventSchema = Type.Union([
  InstallLogEventSchema,
  InstallProbeEventSchema,
  InstallExitEventSchema,
  SSEErrorEventSchema,
]);

export type RuntimeId = Static<typeof RuntimeIdSchema>;
export type RuntimeOrigin = Static<typeof RuntimeOriginSchema>;
export type VersionManagerId = Static<typeof VersionManagerIdSchema>;
export type LtsStatus = Static<typeof LtsStatusSchema>;
export type RuntimeHealth = Static<typeof RuntimeHealthSchema>;
export type RuntimeFindingCode = Static<typeof RuntimeFindingCodeSchema>;
export type RuntimeFindingSeverity = Static<typeof RuntimeFindingSeveritySchema>;
export type RuntimeInstallation = Static<typeof RuntimeInstallationSchema>;
export type RuntimeFinding = Static<typeof RuntimeFindingSchema>;
export type RuntimeStatus = Static<typeof RuntimeStatusSchema>;
export type RuntimeStatusList = Static<typeof RuntimeStatusListSchema>;
export type AgentAuthSignal = Static<typeof AgentAuthSignalSchema>;
export type AgentCliStatus = Static<typeof AgentCliStatusSchema>;
export type AgentCliStatusList = Static<typeof AgentCliStatusListSchema>;
export type ManagedVersion = Static<typeof ManagedVersionSchema>;
export type VersionManagerStatus = Static<typeof VersionManagerStatusSchema>;
export type VersionManagerStatusList = Static<typeof VersionManagerStatusListSchema>;
export type InstallRecipeId = Static<typeof InstallRecipeIdSchema>;
export type InstallAction = Static<typeof InstallActionSchema>;
export type InstallPlatform = Static<typeof InstallPlatformSchema>;
export type NodeVersionSpec = Static<typeof NodeVersionSpecSchema>;
export type RecipeInput = Static<typeof RecipeInputSchema>;
export type InstallGuardReason = Static<typeof InstallGuardReasonSchema>;
export type InstallGuard = Static<typeof InstallGuardSchema>;
export type InstallRecipeDownload = Static<typeof InstallRecipeDownloadSchema>;
export type InstallProfileSetup = Static<typeof InstallProfileSetupSchema>;
export type InstallRecipePreview = Static<typeof InstallRecipePreviewSchema>;
export type InstallPrepareBody = Static<typeof InstallPrepareBodySchema>;
export type InstallPreparation = Static<typeof InstallPreparationSchema>;
export type InstallStartBody = Static<typeof InstallStartBodySchema>;
export type InstallStartResponse = Static<typeof InstallStartResponseSchema>;
export type InstallCancelResponse = Static<typeof InstallCancelResponseSchema>;
export type InstallBlockedResponse = Static<typeof InstallBlockedResponseSchema>;
export type InstallRunStatus = Static<typeof InstallRunStatusSchema>;
export type InstallRun = Static<typeof InstallRunSchema>;
export type InstallRunList = Static<typeof InstallRunListSchema>;
export type InstallLogEvent = Static<typeof InstallLogEventSchema>;
export type InstallProbeEvent = Static<typeof InstallProbeEventSchema>;
export type InstallExitEvent = Static<typeof InstallExitEventSchema>;
export type InstallStreamEvent = Static<typeof InstallStreamEventSchema>;

/**
 * Hub-driven runtime lifecycle actions on an environment card. The hub
 * computes which ones apply per transport so the browser never renders a
 * button it cannot honour. Removal is not one of these: it travels as the
 * `removeRuntime` query param on `DELETE /environments/:id`, not as a
 * lifecycle action.
 */
export const RuntimeLifecycleActionSchema = Type.Union([
  Type.Literal('install'),
  Type.Literal('reinstall'),
  Type.Literal('upgrade'),
  Type.Literal('setup'),
  /**
   * Fetch and verify the matching runtime into the hub's own cache, writing
   * nothing to the target machine.
   *
   * It is deliberately not gated by `allow.update`: that answer governs what a
   * hub may put on someone else's machine, and this puts bytes only on the hub.
   * Refusing hub-driven installs and still wanting the verified binary to carry
   * over yourself is a coherent position, and this is the action that serves it.
   */
  Type.Literal('download'),
]);
export type RuntimeLifecycleAction = Static<typeof RuntimeLifecycleActionSchema>;

/**
 * A verified runtime sitting in the hub's cache, and how to check it by hand.
 *
 * This is what "declined the install" leaves behind. The download is the
 * expensive, network-bound, checksum-verified half of a provision; declining to
 * write it to a machine is no reason to throw it away, and the path plus its
 * checksum line is enough for somebody to finish the job themselves.
 */
export const RuntimeStagedAssetSchema = Type.Object(
  {
    /** Hub version these bytes pair with — the cache directory's name. */
    version: Type.String({ minLength: 1, maxLength: 64 }),
    platformId: Type.String({ minLength: 1, maxLength: 64 }),
    assetName: Type.String({ minLength: 1, maxLength: 256 }),
    /** Absolute path in `~/.mango/runtime-cache/<version>/`. */
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    /** Checks the file on disk against the release `SHA256SUMS`. */
    verify: Type.String({ maxLength: 4_096 }),
    /** Whether the bytes are on disk now, rather than merely resolvable. */
    present: Type.Boolean(),
  },
  { additionalProperties: Type.Never() }
);
export type RuntimeStagedAsset = Static<typeof RuntimeStagedAssetSchema>;

/**
 * Copyable commands for a machine the hub cannot reach (dial-in WS, Direct URL).
 *
 * `platformId` names the release build these commands are for. It is not
 * decoration: the hub only knows a peer's platform once it has connected, and a
 * machine that has never paired is exactly when this block is read — so the
 * card has to say which build it just handed you rather than defaulting
 * silently to Linux.
 */
export const RuntimeManualCommandsSchema = Type.Object(
  {
    platformId: Type.String({ minLength: 1, maxLength: 64 }),
    /** True when `platformId` is a fallback guess rather than a peer-reported platform. */
    platformAssumed: Type.Boolean(),
    install: Type.Optional(Type.String({ maxLength: 4_096 })),
    /** Checksum check against the release `SHA256SUMS`; separate line where one command cannot chain. */
    verify: Type.Optional(Type.String({ maxLength: 4_096 })),
    setup: Type.Optional(Type.String({ maxLength: 4_096 })),
    serviceInstall: Type.Optional(Type.String({ maxLength: 4_096 })),
  },
  { additionalProperties: Type.Never() }
);
export type RuntimeManualCommands = Static<typeof RuntimeManualCommandsSchema>;

/**
 * What the environment card needs to render runtime install/upgrade/setup/
 * removal without re-deriving transport rules or inventing a second health
 * payload. `health` is the last `runtime.health` the hub saw; a disconnected
 * card keeps it with `stale: true` rather than blanking.
 */
export const RuntimeLifecycleViewSchema = Type.Object({
  health: Type.Union([RuntimeHealthReportSchema, Type.Null()]),
  readAt: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  stale: Type.Boolean(),
  slotBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  actions: ReadonlyArraySchema(RuntimeLifecycleActionSchema),
  manualCommands: Type.Optional(RuntimeManualCommandsSchema),
  /**
   * The runtime this hub would install, and whether a verified copy is already
   * staged. Absent when the hub cannot name one — a dev checkout, or a machine
   * that has never reported a platform.
   */
  stagedRuntime: Type.Optional(RuntimeStagedAssetSchema),
  /**
   * Whether the connected runtime re-checks the paths the hub names against
   * the path policy each call carries — the enforcement that keeps a chat
   * restricted to its working directory honest once the filesystem is not the
   * hub's own.
   *
   * Absent while the environment is disconnected: this is a claim a peer makes
   * on `hello`, so with no peer there is no answer, and rendering `false` would
   * accuse a machine that has said nothing.
   */
  enforcesPathPolicy: Type.Optional(Type.Boolean()),
  /**
   * Directory-hash domain the connected runtime computes. Handshake-only, same
   * as `enforcesPathPolicy`: health cannot reconstruct it, and a refresh that
   * dropped it would silently invent a default. Absent while disconnected.
   * Absent on an older connected peer means v2 — the domain that shipped
   * before this field.
   */
  directoryHashDomain: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_DIRECTORY_HASH_DOMAIN_VERSION })
  ),
});
export type RuntimeLifecycleView = Static<typeof RuntimeLifecycleViewSchema>;

export const RuntimeLifecycleStartResponseSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
});
export type RuntimeLifecycleStartResponse = Static<typeof RuntimeLifecycleStartResponseSchema>;

/**
 * Body for POST /environments/:id/runtime/install. Distinguishes install /
 * reinstall / upgrade so the hub can force a byte replace on reinstall and
 * refuse upgrade when the machine denied `allow.update`.
 */
export const RuntimeLifecycleInstallBodySchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal('install'),
      Type.Literal('reinstall'),
      Type.Literal('upgrade'),
      /** Stage into the hub cache only; nothing reaches the target machine. */
      Type.Literal('download'),
    ]),
  },
  { additionalProperties: Type.Never() }
);
export type RuntimeLifecycleInstallBody = Static<typeof RuntimeLifecycleInstallBodySchema>;

export const RuntimeLifecycleCancelResponseSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  cancellationRequested: Type.Boolean(),
});
export type RuntimeLifecycleCancelResponse = Static<typeof RuntimeLifecycleCancelResponseSchema>;

/**
 * Consent the hub asks an SSH machine to record via `setup --yes --json`.
 * A preset profile carries no `allow`: the preset *is* the answer, and a body
 * that could name both would let a request display one consent and record
 * another. `custom` requires an explicit allow matrix with every capability key.
 */
export const RuntimeSetupBodySchema = Type.Union([
  Type.Object(
    {
      profile: Type.Union([Type.Literal('full'), Type.Literal('readonly'), Type.Literal('none')]),
    },
    { additionalProperties: Type.Never() }
  ),
  Type.Object(
    {
      profile: Type.Literal('custom'),
      allow: RuntimeCapabilityAllowSchema,
    },
    { additionalProperties: Type.Never() }
  ),
]);
export type RuntimeSetupBody = Static<typeof RuntimeSetupBodySchema>;

/**
 * Body for POST /environments/:id/runtime/bootstrap — one call that takes an
 * ssh-reachable machine to a paired environment that dials the hub itself.
 *
 * The ssh credentials are **request-scoped**: the hub opens a channel with
 * them, pushes, consents, pairs and installs the service, and keeps nothing.
 * They are deliberately not stored on the environment row, because after this
 * runs the hub never reaches that machine over ssh again — it waits for the
 * machine to dial in. Re-running the flow asks for them again, which is the
 * honest cost of not holding a credential nothing needs.
 *
 * `consent` is the same body `setup` takes on the card, so one consent surface
 * and one `allow.shell` honesty string serve both.
 */
export const RuntimePairedBootstrapBodySchema = Type.Object(
  {
    ssh: SshEnvironmentConfigSchema,
    consent: RuntimeSetupBodySchema,
  },
  { additionalProperties: Type.Never() }
);
export type RuntimePairedBootstrapBody = Static<typeof RuntimePairedBootstrapBodySchema>;
