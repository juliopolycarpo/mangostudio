/**
 * The slice of the Agent Client Protocol this adapter speaks, hand-written.
 *
 * Unlike Codex, Cursor publishes no generated contract to vendor: `cursor-agent`
 * ships as a binary and the ACP schema lives with the protocol rather than with
 * the CLI. So these types are written from two sources and nothing else — the
 * published protocol at agentclientprotocol.com plus Cursor's own
 * cursor.com/docs/cli/acp, and a live handshake against `2026.08.04-aaa8809`
 * whose frames are reproduced in `tests/fixtures/cursor/`.
 *
 * Two consequences shape every declaration below.
 *
 * **Almost everything is optional.** A type written from observation is a
 * description of one build, not a promise from a vendor. Requiring a field this
 * adapter merely happened to see would turn an additive change into a failed
 * turn, so the reducer narrows and checks rather than trusting a cast, and the
 * only fields marked required are the ones a message is meaningless without.
 *
 * **The unions stay open.** `sessionUpdate`, tool kinds, tool statuses,
 * permission option kinds and stop reasons are all `string`-widened, because
 * ACP is versioned independently of Cursor and a member added upstream must
 * arrive as "something this build does not render" rather than as a crash. The
 * known members are listed as literal-union aliases for the code that switches
 * on them.
 *
 * Plan 010 makes the pinning systematic; until it lands, `pinned.ts` carries the
 * minimum version and `adapter.ts` probes the handshake at discovery.
 */

/** ACP major version this client negotiates. */
type AcpProtocolVersion = number;

interface AcpAgentCapabilities {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: {
    readonly audio?: boolean;
    readonly embeddedContext?: boolean;
    readonly image?: boolean;
  };
  /** Presence of `list` is the capability; its body is reserved for options. */
  readonly sessionCapabilities?: { readonly list?: unknown };
  readonly mcpCapabilities?: { readonly http?: boolean; readonly sse?: boolean };
}

export interface AcpInitializeResponse {
  readonly protocolVersion?: AcpProtocolVersion;
  readonly agentCapabilities?: AcpAgentCapabilities;
  readonly authMethods?: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
    readonly description?: string;
  }>;
}

export interface AcpModeState {
  readonly currentModeId?: string;
  readonly availableModes?: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
    readonly description?: string;
  }>;
}

export interface AcpModelState {
  readonly currentModelId?: string;
  readonly availableModels?: ReadonlyArray<{
    readonly modelId?: string;
    readonly name?: string;
    readonly description?: string;
  }>;
}

/** What `session/new` and `session/load` both return; only `new` names the session. */
export interface AcpSessionState {
  readonly sessionId?: string;
  readonly modes?: AcpModeState;
  readonly models?: AcpModelState;
}

/**
 * Why a prompt turn ended.
 *
 * `end_turn` is the only success. `cancelled` is the answer to `session/cancel`
 * and is the adapter's own doing, so it produces no event; the rest are
 * terminals the vendor reached on its own and are reported as errors, because a
 * turn that stopped at a token ceiling is not a turn that finished saying what
 * it meant to.
 */
export type AcpStopReason =
  | 'end_turn'
  | 'cancelled'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | (string & {});

export interface AcpPromptResponse {
  readonly stopReason?: AcpStopReason;
}

interface AcpTextContentBlock {
  readonly type?: string;
  readonly text?: string;
}

type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | (string & {});

/**
 * ACP's tool-kind vocabulary, which is what the activity icon is chosen from.
 * Cursor sends no separate tool *name*, so this doubles as the pill label — see
 * `activityNameFor`.
 */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'
  | (string & {});

export type AcpToolCallContent =
  | { readonly type?: 'content'; readonly content?: AcpTextContentBlock }
  | {
      readonly type?: 'diff';
      readonly path?: string;
      readonly oldText?: string | null;
      readonly newText?: string;
    }
  | { readonly type?: 'terminal'; readonly terminalId?: string }
  | { readonly type?: string };

export interface AcpToolCallFields {
  readonly toolCallId?: string;
  readonly title?: string;
  readonly kind?: AcpToolKind;
  readonly status?: AcpToolCallStatus;
  readonly content?: readonly AcpToolCallContent[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

interface AcpPlanEntry {
  readonly content?: string;
  readonly priority?: string;
  readonly status?: string;
}

/**
 * The `session/update` variants, keyed by `sessionUpdate`.
 *
 * Observed live: `session_info_update`, `available_commands_update`,
 * `agent_thought_chunk`, `agent_message_chunk`, `tool_call`, `tool_call_update`
 * and `current_mode_update`. `user_message_chunk` and `plan` are ACP core and
 * are handled without having been observed here.
 *
 * Split into one interface per variant rather than one wide object, because
 * `content` means a content block on a message chunk and a list of tool-call
 * content on a tool call — the same key carrying two shapes is exactly what a
 * single flattened type would hide.
 */
export interface AcpSessionUpdateEnvelope {
  readonly sessionUpdate?: string;
}

export interface AcpMessageChunkUpdate extends AcpSessionUpdateEnvelope {
  readonly content?: AcpTextContentBlock;
}

export interface AcpToolCallUpdate extends AcpSessionUpdateEnvelope, AcpToolCallFields {}

export interface AcpPlanUpdate extends AcpSessionUpdateEnvelope {
  readonly entries?: readonly AcpPlanEntry[];
}

/** One entry of the slash-command catalog Cursor announces per session. */
export interface AcpAvailableCommand {
  readonly name?: unknown;
  readonly description?: unknown;
}

/**
 * The catalog itself, sent once when the session opens.
 *
 * Cursor does not re-send it: a command file written mid-session still expands
 * when typed, but this list will not mention it until the next session. That is
 * the vendor's behaviour, observed live, and the reason a consumer treats the
 * catalog as a hint rather than an allowlist.
 */
export interface AcpAvailableCommandsUpdate extends AcpSessionUpdateEnvelope {
  readonly availableCommands?: unknown;
}

/**
 * The raw notification body.
 *
 * `update` is left `unknown` on purpose: the reducer narrows on `sessionUpdate`
 * before touching anything else, which is the only order in which a field's
 * type is actually known.
 */
export interface AcpSessionNotification {
  readonly sessionId?: string;
  readonly update?: unknown;
}

type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | (string & {});

interface AcpPermissionOption {
  readonly optionId?: string;
  readonly name?: string;
  readonly kind?: AcpPermissionOptionKind;
}

export interface AcpRequestPermissionParams {
  readonly sessionId?: string;
  readonly toolCall?: AcpToolCallFields;
  readonly options?: readonly AcpPermissionOption[];
}

/**
 * The permission answer.
 *
 * `cancelled` is the protocol's own way to say the client is not going to
 * answer — a turn that ended, a session that closed, a request nobody could be
 * shown. It is never a decision on the user's behalf, which is the distinction
 * the whole approval path exists to keep.
 */
export type AcpRequestPermissionResponse =
  | { readonly outcome: { readonly outcome: 'selected'; readonly optionId: string } }
  | { readonly outcome: { readonly outcome: 'cancelled' } };

interface AcpListedSession {
  readonly sessionId?: string;
  readonly cwd?: string;
  /** ISO-8601, unlike Codex's Unix seconds. There is no title field. */
  readonly updatedAt?: string;
}

export interface AcpSessionListResponse {
  readonly sessions?: readonly AcpListedSession[];
  readonly nextCursor?: string | null;
}

/** `cursor-agent status --format json`. Only the sign-in facts are read. */
export interface CursorStatusResponse {
  readonly status?: string;
  readonly isAuthenticated?: boolean;
  readonly userInfo?: { readonly email?: string };
}
