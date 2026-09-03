/**
 * Live terminal contract: one interactive shell on the machine an environment
 * describes, opened through the hub and driven from a browser.
 *
 * The runtime owns the PTY. The hub owns who may open one, keeps the session
 * registry, and relays bytes over its own WebSocket route (`/api/terminal/:id`)
 * because `/api/ws` is invalidation-only. The browser renders. The limits live
 * here so all three agree on chunk sizes and windows; a runtime that chunks at
 * a size the hub's socket refuses is a closed socket, not a slow one.
 */

import type { Static } from 'typebox';
import Type from 'typebox';
import {
  HUB_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES,
  HUB_WEBSOCKET_MAX_PAYLOAD_BYTES,
  REALTIME_CLOSE_CODES,
} from '../realtime/schemas';
import { RuntimeShellKindSchema } from '../runtime-protocol/schemas';

/** Largest raw byte run in one `terminal.output` frame and one socket data frame. */
export const TERMINAL_CHUNK_MAX_BYTES = 8 * 1024;
/**
 * Largest browser→hub message, including its one-byte type prefix: exactly the
 * payload ceiling every hub WebSocket route enforces. Derived rather than
 * restated, so it cannot drift past the transport that has to carry it.
 */
export const TERMINAL_CLIENT_MESSAGE_MAX_BYTES = HUB_WEBSOCKET_MAX_PAYLOAD_BYTES;
/** Bytes of output the runtime keeps per session for `terminal.attach` replay. */
export const TERMINAL_SCROLLBACK_MAX_BYTES = 256 * 1024;
/**
 * Bytes the runtime may have emitted and not yet seen acknowledged. Past this
 * it parks output in the pending buffer rather than pushing more frames at a
 * transport that cannot refuse them.
 */
export const TERMINAL_INFLIGHT_WINDOW_BYTES = 256 * 1024;
/**
 * Bytes the runtime parks for an attached viewer that is not acknowledging.
 * Past this the oldest bytes are discarded and one `dropped` marker is sent;
 * `Bun.Terminal` cannot stop reading the PTY, so the alternative is unbounded
 * memory on the machine the runtime runs on.
 */
export const TERMINAL_PENDING_MAX_BYTES = 1024 * 1024;
/** Bytes the hub queues per browser socket before it drops with a notice. */
export const TERMINAL_HUB_QUEUE_MAX_BYTES = 1024 * 1024;
/**
 * Hub-side send high-water mark. The hub closes a socket at its backpressure
 * limit, so the relay holds its queue at three quarters of that instead of
 * letting Bun decide — derived, so raising the limit moves this with it.
 */
export const TERMINAL_SOCKET_SEND_HIGH_WATER_BYTES =
  (HUB_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES / 4) * 3;
/**
 * Client frames the hub will hold un-dispatched per socket. Each one is a
 * `terminal.*` round trip to the runtime and they are serialized, so without a
 * ceiling a client that sends faster than the runtime answers grows the hub's
 * promise chain — and up to `TERMINAL_CLIENT_MESSAGE_MAX_BYTES` per entry —
 * without bound. `/api/ws` bounds its own chain the same way; a terminal only
 * needs a larger number because a paste is many frames at once.
 */
export const TERMINAL_SOCKET_MAX_PENDING_MESSAGES = 256;

export const TERMINAL_COLS_MIN = 2;
export const TERMINAL_COLS_MAX = 500;
export const TERMINAL_ROWS_MIN = 1;
export const TERMINAL_ROWS_MAX = 300;
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;
export const TERMINAL_TITLE_MAX_LENGTH = 64;
export const TERMINAL_CWD_MAX_LENGTH = 4_096;

/** Browser-facing socket path; the session id is appended as one segment. */
export const TERMINAL_SOCKET_PATH = '/api/terminal';

/**
 * Close codes the terminal socket uses. The rejection triple is *derived* from
 * `REALTIME_CLOSE_CODES` rather than restated, so a browser socket rejects the
 * same way on every route by construction; the rest are this route's own.
 * `REPLACED` is the one a client must not reconnect from: another viewer took
 * the session, on purpose.
 */
export const TERMINAL_SOCKET_CLOSE_CODES = {
  UNAUTHORIZED: REALTIME_CLOSE_CODES.UNAUTHORIZED,
  FORBIDDEN: REALTIME_CLOSE_CODES.FORBIDDEN,
  RATE_LIMITED: REALTIME_CLOSE_CODES.RATE_LIMITED,
  INTERNAL_ERROR: REALTIME_CLOSE_CODES.INTERNAL_ERROR,
  NOT_FOUND: 4404,
  REPLACED: 4409,
  GONE: 4410,
} as const;
export type TerminalSocketCloseCode =
  (typeof TERMINAL_SOCKET_CLOSE_CODES)[keyof typeof TERMINAL_SOCKET_CLOSE_CODES];

export const TerminalSessionStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('exited'),
]);
export type TerminalSessionStatus = Static<typeof TerminalSessionStatusSchema>;

export const TerminalSizeSchema = Type.Object(
  {
    cols: Type.Integer({ minimum: TERMINAL_COLS_MIN, maximum: TERMINAL_COLS_MAX }),
    rows: Type.Integer({ minimum: TERMINAL_ROWS_MIN, maximum: TERMINAL_ROWS_MAX }),
  },
  { additionalProperties: false }
);
export type TerminalSize = Static<typeof TerminalSizeSchema>;

/** How the shell ended. Both null when the runtime lost the process without a status. */
export const TerminalExitSchema = Type.Object(
  {
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
  },
  { additionalProperties: false }
);
export type TerminalExit = Static<typeof TerminalExitSchema>;

/**
 * Something the relay wants drawn as a dim line rather than as output.
 * `dropped` is bytes the runtime discarded; `queue_overflow` is bytes the hub
 * discarded; `runtime_disconnected` means the session died with its runtime.
 */
export const TerminalNoticeSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('dropped'),
      Type.Literal('queue_overflow'),
      Type.Literal('runtime_disconnected'),
    ]),
    bytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);
export type TerminalNotice = Static<typeof TerminalNoticeSchema>;

export const TerminalSessionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  environmentId: Type.String({ minLength: 1 }),
  /** The chat this session was opened from; null for a session opened from the pop-out. */
  chatId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  title: Type.String({ minLength: 1, maxLength: TERMINAL_TITLE_MAX_LENGTH }),
  shell: RuntimeShellKindSchema,
  cwd: Type.Union([Type.String({ maxLength: TERMINAL_CWD_MAX_LENGTH }), Type.Null()]),
  cols: Type.Integer({ minimum: TERMINAL_COLS_MIN, maximum: TERMINAL_COLS_MAX }),
  rows: Type.Integer({ minimum: TERMINAL_ROWS_MIN, maximum: TERMINAL_ROWS_MAX }),
  status: TerminalSessionStatusSchema,
  /** Present once `status` is `exited`. */
  exit: Type.Optional(TerminalExitSchema),
  /** Whether a browser socket currently holds the session. One viewer at a time. */
  attached: Type.Boolean(),
  createdAt: Type.Integer({ minimum: 0 }),
  /** Last open, attach, detach or write; the idle reaper reads it. */
  lastActivityAt: Type.Integer({ minimum: 0 }),
});
export type TerminalSession = Static<typeof TerminalSessionSchema>;

export const TerminalOpenBodySchema = Type.Object(
  {
    environmentId: Type.String({ minLength: 1 }),
    chatId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
    /** Omitted: the runtime picks the login shell when it is one it offers. */
    shell: Type.Optional(RuntimeShellKindSchema),
    /** Omitted: the chat's working directory, else the runtime user's home. */
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: TERMINAL_CWD_MAX_LENGTH })),
    cols: Type.Optional(Type.Integer({ minimum: TERMINAL_COLS_MIN, maximum: TERMINAL_COLS_MAX })),
    rows: Type.Optional(Type.Integer({ minimum: TERMINAL_ROWS_MIN, maximum: TERMINAL_ROWS_MAX })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: TERMINAL_TITLE_MAX_LENGTH })),
  },
  { additionalProperties: false }
);
export type TerminalOpenBody = Static<typeof TerminalOpenBodySchema>;

export const TerminalRenameBodySchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: TERMINAL_TITLE_MAX_LENGTH }),
  },
  { additionalProperties: false }
);
export type TerminalRenameBody = Static<typeof TerminalRenameBodySchema>;

export const TerminalListQuerySchema = Type.Object({
  environmentId: Type.Optional(Type.String({ minLength: 1 })),
  chatId: Type.Optional(Type.String({ minLength: 1 })),
});
export type TerminalListQuery = Static<typeof TerminalListQuerySchema>;

export const TerminalSessionResponseSchema = Type.Object({
  session: TerminalSessionSchema,
});
export type TerminalSessionResponse = Static<typeof TerminalSessionResponseSchema>;

export const TerminalListResponseSchema = Type.Object({
  sessions: Type.Array(TerminalSessionSchema),
});
export type TerminalListResponse = Static<typeof TerminalListResponseSchema>;

/**
 * Why a terminal cannot be opened here, as the API answers it. The client
 * words these; the wire carries the code.
 */
export const TerminalRefusalReasonSchema = Type.Union([
  /** `[terminal] enabled = false` on the hub. */
  Type.Literal('disabled'),
  /** The user already holds `max_sessions_per_user` running sessions. */
  Type.Literal('limit'),
  /** A Local runtime on a hub that has more than one user. */
  Type.Literal('not-isolated'),
  /** The environment's runtime does not offer a PTY, or the owner refused `shell`. */
  Type.Literal('unavailable'),
  /** The environment has no live runtime connection right now. */
  Type.Literal('disconnected'),
]);
export type TerminalRefusalReason = Static<typeof TerminalRefusalReasonSchema>;

/**
 * Whether the caller may open a terminal on an environment right now, and
 * with which shells. Answered by `GET /api/terminals/availability` so the
 * panel can explain a refusal before anyone types a command.
 */
export const TerminalAvailabilitySchema = Type.Object({
  environmentId: Type.String({ minLength: 1 }),
  available: Type.Boolean(),
  /** Present when `available` is false. */
  reason: Type.Optional(TerminalRefusalReasonSchema),
  /** Shells the runtime offers; empty when unavailable. */
  shells: Type.Array(RuntimeShellKindSchema),
  /** Running sessions the caller already holds, against the per-user cap. */
  openSessions: Type.Integer({ minimum: 0 }),
  maxSessions: Type.Integer({ minimum: 0 }),
});
export type TerminalAvailability = Static<typeof TerminalAvailabilitySchema>;

export const TerminalAvailabilityQuerySchema = Type.Object({
  environmentId: Type.String({ minLength: 1 }),
});
export type TerminalAvailabilityQuery = Static<typeof TerminalAvailabilityQuerySchema>;
