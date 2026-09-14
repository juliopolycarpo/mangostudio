/**
 * The interactive-terminal method family: opening a PTY on a runtime, driving
 * it from an attached viewer, and the session bookkeeping `terminal.list`
 * answers with.
 *
 * Schema-first, like its siblings — the schema is the source and the type is
 * `Static<>` of it. `cols`/`rows` on the two calls that open or resize a
 * session carry the one hand-asserted bound in this family, mirroring
 * `assertTerminalSize` in `apps/runtime/src/services/terminal/session.ts`;
 * everywhere else, including the `cols`/`rows` read back off a live session
 * in {@link RuntimeTerminalSessionSummarySchema}, a number stays a number.
 */

import Type, { type Static } from 'typebox';
import { ToolchainSelectionSchema } from '../../environments/toolchain-schemas';
import { ReadonlyArraySchema, ReadonlyRecordSchema } from '../../schema-helpers';
import {
  TERMINAL_COLS_MAX,
  TERMINAL_COLS_MIN,
  TERMINAL_ROWS_MAX,
  TERMINAL_ROWS_MIN,
} from '../../terminal/schemas';
import { RuntimeShellKindSchema } from '../manifest';
import { RuntimeShellEnvPolicySchema } from './shell';

/**
 * Bounds `assertTerminalSize` enforces by hand today (integer, `TERMINAL_COLS_MIN`
 * to `TERMINAL_COLS_MAX`); mirrored here rather than invented.
 */
const RuntimeTerminalColsSchema = Type.Integer({
  minimum: TERMINAL_COLS_MIN,
  maximum: TERMINAL_COLS_MAX,
});
/**
 * Bounds `assertTerminalSize` enforces by hand today (integer, `TERMINAL_ROWS_MIN`
 * to `TERMINAL_ROWS_MAX`); mirrored here rather than invented.
 */
const RuntimeTerminalRowsSchema = Type.Integer({
  minimum: TERMINAL_ROWS_MIN,
  maximum: TERMINAL_ROWS_MAX,
});

export const RuntimeTerminalSessionStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('exited'),
]);
export type RuntimeTerminalSessionStatus = Static<typeof RuntimeTerminalSessionStatusSchema>;

export const RuntimeTerminalOpenParamsSchema = Type.Object({
  /** Hub-minted session id. It is the stream key, so it is part of the contract. */
  sessionId: Type.String(),
  /** Omitted: the login shell when it is one this runtime offers, else the first available. */
  shell: Type.Optional(RuntimeShellKindSchema),
  /** Omitted: the runtime user's home. `~` expands like `shell.run`. */
  cwd: Type.Optional(Type.String()),
  cols: RuntimeTerminalColsSchema,
  rows: RuntimeTerminalRowsSchema,
  /** Variables layered over the sanitized host env. Never secrets; the hub does not hold any to send. */
  env: Type.Optional(ReadonlyRecordSchema(Type.String())),
  envPolicy: Type.Optional(RuntimeShellEnvPolicySchema),
  /** Omitted: `TERMINAL_SCROLLBACK_MAX_BYTES`, which is also the hard ceiling this is clamped to. */
  scrollbackBytes: Type.Optional(Type.Number()),
  /** Absent: inherit the runtime's own PATH; the hub always sends the environment's selection. */
  toolchain: Type.Optional(ToolchainSelectionSchema),
});
export type RuntimeTerminalOpenParams = Static<typeof RuntimeTerminalOpenParamsSchema>;

export const RuntimeTerminalOpenResultSchema = Type.Object({
  sessionId: Type.String(),
  shell: RuntimeShellKindSchema,
  cwd: Type.String(),
  pid: Type.Number(),
});
export type RuntimeTerminalOpenResult = Static<typeof RuntimeTerminalOpenResultSchema>;

export const RuntimeTerminalAttachParamsSchema = Type.Object({
  sessionId: Type.String(),
});
export type RuntimeTerminalAttachParams = Static<typeof RuntimeTerminalAttachParamsSchema>;

/**
 * Attaching replays what the session kept and starts the live stream. The
 * in-flight window is re-based by the attach: whatever was unacknowledged for a
 * previous viewer is owed nothing by this one, and the replay below is charged
 * to the window instead, because the viewer acks replayed bytes exactly as it
 * acks live ones.
 */
export const RuntimeTerminalAttachResultSchema = Type.Object({
  sessionId: Type.String(),
  /** Base64 of the last `scrollbackBytes` (default, and hard ceiling: `TERMINAL_SCROLLBACK_MAX_BYTES`) bytes of output. */
  scrollback: Type.String(),
  status: RuntimeTerminalSessionStatusSchema,
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  cols: Type.Number(),
  rows: Type.Number(),
});
export type RuntimeTerminalAttachResult = Static<typeof RuntimeTerminalAttachResultSchema>;

export const RuntimeTerminalDetachParamsSchema = Type.Object({
  sessionId: Type.String(),
});
export type RuntimeTerminalDetachParams = Static<typeof RuntimeTerminalDetachParamsSchema>;

export const RuntimeTerminalWriteParamsSchema = Type.Object({
  sessionId: Type.String(),
  /** Base64 of the keystrokes; at most `TERMINAL_CLIENT_MESSAGE_MAX_BYTES` raw. */
  data: Type.String(),
});
export type RuntimeTerminalWriteParams = Static<typeof RuntimeTerminalWriteParamsSchema>;

export const RuntimeTerminalResizeParamsSchema = Type.Object({
  sessionId: Type.String(),
  cols: RuntimeTerminalColsSchema,
  rows: RuntimeTerminalRowsSchema,
});
export type RuntimeTerminalResizeParams = Static<typeof RuntimeTerminalResizeParamsSchema>;

export const RuntimeTerminalAckParamsSchema = Type.Object({
  sessionId: Type.String(),
  /** Raw output bytes the viewer has consumed since its last ack. */
  bytes: Type.Number(),
});
export type RuntimeTerminalAckParams = Static<typeof RuntimeTerminalAckParamsSchema>;

export const RuntimeTerminalCloseParamsSchema = Type.Object({
  sessionId: Type.String(),
});
export type RuntimeTerminalCloseParams = Static<typeof RuntimeTerminalCloseParamsSchema>;

export const RuntimeTerminalSessionSummarySchema = Type.Object({
  sessionId: Type.String(),
  shell: RuntimeShellKindSchema,
  cwd: Type.String(),
  cols: Type.Number(),
  rows: Type.Number(),
  status: RuntimeTerminalSessionStatusSchema,
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  attached: Type.Boolean(),
  pid: Type.Number(),
});
export type RuntimeTerminalSessionSummary = Static<typeof RuntimeTerminalSessionSummarySchema>;

export const RuntimeTerminalListResultSchema = Type.Object({
  sessions: ReadonlyArraySchema(RuntimeTerminalSessionSummarySchema),
});
export type RuntimeTerminalListResult = Static<typeof RuntimeTerminalListResultSchema>;
