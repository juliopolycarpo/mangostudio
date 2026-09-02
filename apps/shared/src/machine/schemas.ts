/**
 * The hub's own machine: what process is serving, how it was launched, whether
 * a service keeps it alive, and what doctor says about the install. One shape
 * feeds `mangostudio status --json` and `GET /api/machine/status`, so a
 * terminal and the "This machine" page cannot disagree.
 */

import type { Static } from 'typebox';
import Type from 'typebox';
import { InstallGuardSchema } from '../environments/schemas';
import { RuntimeConsentProfileSchema, UserServiceStatusSchema } from '../runtime-home/schemas';
import { ReadonlyArraySchema } from '../schema-helpers';

/** How the serving process came to exist, which decides how it can be restarted. */
export const HubLaunchModeSchema = Type.Union([
  Type.Literal('service'),
  Type.Literal('detached'),
  Type.Literal('foreground'),
]);
export type HubLaunchMode = Static<typeof HubLaunchModeSchema>;

/**
 * Whether the process answered `/api/health`. `unprobed` is not a failure: a
 * hub bound to one explicit LAN address cannot be reached over loopback, and
 * the probe will not fetch an arbitrary host named in a local state file, so
 * there is nothing it can honestly say either way.
 */
export const HubHealthSchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('unreachable'),
  Type.Literal('unprobed'),
]);
export type HubHealth = Static<typeof HubHealthSchema>;

/**
 * The single-instance state file, as a status. Every field after `running` is
 * absent when nothing is serving, so a stale file never reads as a live hub.
 */
export const HubProcessStatusSchema = Type.Object({
  running: Type.Boolean(),
  pid: Type.Optional(Type.Integer({ minimum: 1 })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
  host: Type.Optional(Type.String({ maxLength: 256 })),
  /** The address a browser on this machine reaches it at. */
  url: Type.Optional(Type.String({ maxLength: 512 })),
  startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  uptimeMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Empty for a foreground start, whose output goes to its terminal. */
  logFile: Type.Optional(Type.String({ maxLength: 4_096 })),
  version: Type.Optional(Type.String({ maxLength: 128 })),
  buildSha: Type.Optional(Type.String({ maxLength: 64 })),
  buildType: Type.Optional(Type.String({ maxLength: 32 })),
  builtAt: Type.Optional(Type.String({ maxLength: 64 })),
  health: Type.Optional(HubHealthSchema),
  launch: Type.Optional(HubLaunchModeSchema),
  /** The supervisor unit that started this process, when `launch` is `service`. */
  serviceUnit: Type.Optional(Type.String({ maxLength: 256 })),
});
export type HubProcessStatus = Static<typeof HubProcessStatusSchema>;

export const MachineCheckStatusSchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('warn'),
  Type.Literal('fail'),
]);
export type MachineCheckStatus = Static<typeof MachineCheckStatusSchema>;

/**
 * Caps on the strings this hub writes about itself. Exported because the writer
 * has to know them: a doctor detail, a probe error and a supervisor's stderr are
 * all unbounded at the source, and a response that overruns its own schema is
 * answered as a 500 rather than as the document with one long line in it.
 */
export const MACHINE_CHECK_LABEL_MAX = 128;
export const MACHINE_CHECK_DETAIL_MAX = 4_096;
/** Cap on every `error` string in the status document. */
export const MACHINE_ERROR_MAX = 1_024;

/** One doctor row, exactly as the CLI prints it. */
export const MachineCheckSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: MACHINE_CHECK_LABEL_MAX }),
  status: MachineCheckStatusSchema,
  detail: Type.String({ maxLength: MACHINE_CHECK_DETAIL_MAX }),
});
export type MachineCheck = Static<typeof MachineCheckSchema>;

export const MACHINE_DOCTOR_CHECK_LIMIT = 512;

export const MachineDoctorReportSchema = Type.Object({
  checks: ReadonlyArraySchema(MachineCheckSchema, { maxItems: MACHINE_DOCTOR_CHECK_LIMIT }),
  warnings: Type.Integer({ minimum: 0 }),
  failures: Type.Integer({ minimum: 0 }),
});
export type MachineDoctorReport = Static<typeof MachineDoctorReportSchema>;

/**
 * Optional doctor sections. Core checks always run; these spawn probes and
 * already have pages of their own, so a caller opts into them.
 */
export const MachineDoctorSectionSchema = Type.Union([
  Type.Literal('environments'),
  Type.Literal('library'),
]);
export type MachineDoctorSection = Static<typeof MachineDoctorSectionSchema>;

/** The sibling runtime binary the hub spawns for stdio environments. */
export const MachineRuntimeBinarySchema = Type.Object({
  /** Null in a source checkout, which runs the runtime through Bun instead. */
  path: Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()]),
  present: Type.Boolean(),
  version: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
  /** Whether it reports the hub's own version; null when it could not be asked. */
  versionMatches: Type.Union([Type.Boolean(), Type.Null()]),
  error: Type.Union([Type.String({ maxLength: MACHINE_ERROR_MAX }), Type.Null()]),
});
export type MachineRuntimeBinary = Static<typeof MachineRuntimeBinarySchema>;

/** What the `host` runtime slot on this machine has consented to. */
export const MachineHostSlotSchema = Type.Object({
  /** False when no slot directory exists, which means full consent by default. */
  present: Type.Boolean(),
  profile: RuntimeConsentProfileSchema,
  directory: Type.String({ maxLength: 4_096 }),
  error: Type.Union([Type.String({ maxLength: MACHINE_ERROR_MAX }), Type.Null()]),
});
export type MachineHostSlot = Static<typeof MachineHostSlotSchema>;

/** Why the page will not perform an action; each has a sentence in i18n. */
export const MachineActionReasonSchema = Type.Union([
  /** The local-surface guard refused; `actions.guard.reasons` says which check. */
  Type.Literal('guard'),
  /** The server was started in a terminal, which owns its lifecycle. */
  Type.Literal('foreground'),
  /** A Scheduled Task cannot restart itself from inside its own process tree. */
  Type.Literal('windows-service'),
  Type.Literal('already-installed'),
  Type.Literal('not-installed'),
  Type.Literal('unsupported-platform'),
  /** The supervisor could not be asked; `service.error` has the detail. */
  Type.Literal('service-unreadable'),
  /** The auth secret lives only in this process's environment; a unit could not find it. */
  Type.Literal('secret-not-persisted'),
]);
export type MachineActionReason = Static<typeof MachineActionReasonSchema>;

/**
 * One mutating action the page may offer. `command` is what to type instead
 * when `available` is false, and `reason` says why the page will not do it.
 */
export const MachineActionSchema = Type.Object({
  available: Type.Boolean(),
  command: Type.String({ minLength: 1, maxLength: 512 }),
  reason: Type.Optional(MachineActionReasonSchema),
});
export type MachineAction = Static<typeof MachineActionSchema>;

export const MachineActionsSchema = Type.Object({
  /** The local-surface guard every mutating action shares. */
  guard: InstallGuardSchema,
  restart: MachineActionSchema,
  installService: MachineActionSchema,
  uninstallService: MachineActionSchema,
});
export type MachineActions = Static<typeof MachineActionsSchema>;

export const MachineStatusSchema = Type.Object({
  hub: HubProcessStatusSchema,
  service: UserServiceStatusSchema,
  runtimeBinary: MachineRuntimeBinarySchema,
  hostSlot: MachineHostSlotSchema,
  platform: Type.String({ minLength: 1, maxLength: 32 }),
  standalone: Type.Boolean(),
  container: Type.Boolean(),
  homeDir: Type.String({ maxLength: 4_096 }),
  logsDir: Type.String({ maxLength: 4_096 }),
  configFile: Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()]),
  actions: MachineActionsSchema,
});
export type MachineStatus = Static<typeof MachineStatusSchema>;

export const MACHINE_LOG_TAIL_DEFAULT = 200;
export const MACHINE_LOG_TAIL_MAX = 2_000;

export const MachineLogTailSchema = Type.Object({
  /** Null when the serving process writes to a terminal, not a file. */
  file: Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()]),
  lines: ReadonlyArraySchema(Type.String({ maxLength: 8_192 }), {
    maxItems: MACHINE_LOG_TAIL_MAX,
  }),
  /** True when the file holds more lines than were returned. */
  truncated: Type.Boolean(),
});
export type MachineLogTail = Static<typeof MachineLogTailSchema>;

export const MachineServiceActionSchema = Type.Union([
  Type.Literal('install'),
  Type.Literal('uninstall'),
]);
export type MachineServiceAction = Static<typeof MachineServiceActionSchema>;

export const MachineServiceBodySchema = Type.Object(
  { action: MachineServiceActionSchema },
  { additionalProperties: false }
);
export type MachineServiceBody = Static<typeof MachineServiceBodySchema>;

/**
 * What an accepted action set in motion. A code rather than a sentence: the
 * hub does not know the locale of the browser that asked, and the page has the
 * dictionaries. Each one has a sentence in i18n.
 */
export const MachineActionOutcomeSchema = Type.Union([
  /** The supervisor was asked to bounce the unit that runs this hub. */
  Type.Literal('restarting-service'),
  /** A successor was spawned and this process stands down behind it. */
  Type.Literal('restarting-detached'),
  /** The unit is installed and this process is handing the port over to it. */
  Type.Literal('service-installed-handover'),
  /** The unit is installed; what is serving did not have to change. */
  Type.Literal('service-installed'),
  /** The unit is being removed, and this process stops along with it. */
  Type.Literal('service-removing'),
  /** The unit is gone and this process keeps serving. */
  Type.Literal('service-removed'),
]);
export type MachineActionOutcome = Static<typeof MachineActionOutcomeSchema>;

/** A mutating action was accepted; `outcome` says what happens next. */
export const MachineActionResponseSchema = Type.Object({
  accepted: Type.Boolean(),
  outcome: MachineActionOutcomeSchema,
  /** The unit the outcome is about, when it names one. */
  unit: Type.Optional(Type.String({ maxLength: 256 })),
});
export type MachineActionResponse = Static<typeof MachineActionResponseSchema>;
