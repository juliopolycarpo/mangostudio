/**
 * The install-run method family: launching a hub-built command on the
 * runtime's machine and streaming its outcome back, plus cancelling one in
 * flight.
 *
 * Schema-first, like its siblings — the schema is the source and the type is
 * `Static<>` of it.
 */

import Type, { type Static } from 'typebox';
import { ToolchainSelectionSchema } from '../../environments/toolchain-schemas';
import { ReadonlyArraySchema, ReadonlyRecordSchema } from '../../schema-helpers';

export const RuntimeInstallRunParamsSchema = Type.Object({
  /** Hub-minted run id. It is the stream key, so it is part of the contract. */
  runId: Type.String(),
  /** Already built by the hub from a code-defined recipe; never interpolated here. */
  argv: ReadonlyArraySchema(Type.String()),
  env: Type.Optional(ReadonlyRecordSchema(Type.String())),
  timeoutMs: Type.Number(),
  /** Where this machine keeps the run's log; the hub's own path means nothing here. */
  logPath: Type.String(),
  outputLimitBytes: Type.Optional(Type.Number()),
  /**
   * Exit codes besides 0 that still mean success — winget exits with its own
   * "no applicable update found" code when a package is already current, and
   * that is not a failure MangoStudio should report as one.
   */
  acceptedExitCodes: Type.Optional(ReadonlyArraySchema(Type.Number())),
  /** Absent: inherit the runtime's own PATH; the hub always sends the environment's selection. */
  toolchain: Type.Optional(ToolchainSelectionSchema),
});
export type RuntimeInstallRunParams = Static<typeof RuntimeInstallRunParamsSchema>;

export const RuntimeInstallRunResultSchema = Type.Object({
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  status: Type.Union([
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
    Type.Literal('timed-out'),
    Type.Literal('spawn-failed'),
  ]),
  truncated: Type.Boolean(),
  finishedAt: Type.Number(),
  durationMs: Type.Number(),
});
export type RuntimeInstallRunResult = Static<typeof RuntimeInstallRunResultSchema>;

export const RuntimeInstallCancelParamsSchema = Type.Object({
  runId: Type.String(),
});
export type RuntimeInstallCancelParams = Static<typeof RuntimeInstallCancelParamsSchema>;
