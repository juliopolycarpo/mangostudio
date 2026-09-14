/**
 * The `shell.run`, `git.exec` and `gh.exec`/`gh.mutate` method family: running
 * an interpreter or a vendor CLI on the runtime host and reporting back what
 * happened.
 *
 * Schema-first, like the families that import it — the schema is the source
 * and the type is `Static<>` of it.
 */

import Type, { type Static } from 'typebox';
import { ToolchainSelectionSchema } from '../../environments/toolchain-schemas';
import { ReadonlyArraySchema } from '../../schema-helpers';
import { RuntimeShellKindSchema } from '../manifest';

/** The `envPolicy` shape, shared with the terminal family's `terminal.open`. */
export const RuntimeShellEnvPolicySchema = Type.Object({
  allow: Type.Optional(ReadonlyArraySchema(Type.String())),
  deny: Type.Optional(ReadonlyArraySchema(Type.String())),
});
export type RuntimeShellEnvPolicy = Static<typeof RuntimeShellEnvPolicySchema>;

export const RuntimeShellRunParamsSchema = Type.Object({
  kind: RuntimeShellKindSchema,
  command: Type.String(),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Number(),
  maxOutputBytes: Type.Number(),
  envPolicy: Type.Optional(RuntimeShellEnvPolicySchema),
  /** Absent: inherit the runtime's own PATH; the hub always sends the environment's selection. */
  toolchain: Type.Optional(ToolchainSelectionSchema),
});
export type RuntimeShellRunParams = Static<typeof RuntimeShellRunParamsSchema>;

export const RuntimeShellResultSchema = Type.Object({
  shell: RuntimeShellKindSchema,
  command: Type.String(),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  stdout: Type.String(),
  stderr: Type.String(),
  truncated: Type.Boolean(),
  termination: Type.Union([
    Type.Object({ kind: Type.Literal('exited') }),
    Type.Object({ kind: Type.Literal('timed_out') }),
    Type.Object({ kind: Type.Literal('aborted') }),
    Type.Object({ kind: Type.Literal('signalled'), signal: Type.String() }),
  ]),
  durationMs: Type.Number(),
});
export type RuntimeShellResult = Static<typeof RuntimeShellResultSchema>;

export const RuntimeGitExecParamsSchema = Type.Object({
  args: ReadonlyArraySchema(Type.String()),
  cwd: Type.String(),
  timeoutMs: Type.Optional(Type.Number()),
  acceptedExitCodes: Type.Optional(ReadonlyArraySchema(Type.Number())),
});
export type RuntimeGitExecParams = Static<typeof RuntimeGitExecParamsSchema>;

export const RuntimeGitExecResultSchema = Type.Object({
  stdout: Type.String(),
  stderr: Type.String(),
  exitCode: Type.Number(),
  /**
   * Git exited, but a surviving helper (credential helper, backgrounded child)
   * still held a pipe open when the capture stopped, so `stdout`/`stderr` may
   * be short of what Git actually wrote. Omitted — not `false` — when the
   * capture drained normally, so an older peer that has never heard of this
   * field is read the same way as a complete capture.
   */
  incomplete: Type.Optional(Type.Boolean()),
});
export type RuntimeGitExecResult = Static<typeof RuntimeGitExecResultSchema>;

/**
 * Params for both `gh.exec` and `gh.mutate`.
 *
 * One shape, two methods. The split is not about what a call looks like — it is
 * about what consent it needs, and the gate decides that from the method name
 * alone (see `consent-gate.ts`), so the read/write line has to be drawn between
 * two methods rather than between two values of one parameter.
 */
export const RuntimeGhExecParamsSchema = Type.Object({
  args: ReadonlyArraySchema(Type.String()),
  cwd: Type.String(),
  timeoutMs: Type.Optional(Type.Number()),
  acceptedExitCodes: Type.Optional(ReadonlyArraySchema(Type.Number())),
});
export type RuntimeGhExecParams = Static<typeof RuntimeGhExecParamsSchema>;

export const RuntimeGhExecResultSchema = Type.Object({
  stdout: Type.String(),
  stderr: Type.String(),
  exitCode: Type.Number(),
  /**
   * `gh` exited, but a surviving child (it runs git, and git runs credential
   * helpers) still held a pipe open when the capture stopped, so the captured
   * text may be short of what `gh` actually wrote. Omitted rather than `false`
   * on a clean drain, so an older peer that never learned the field reads the
   * same as a complete capture.
   */
  incomplete: Type.Optional(Type.Boolean()),
});
export type RuntimeGhExecResult = Static<typeof RuntimeGhExecResultSchema>;
