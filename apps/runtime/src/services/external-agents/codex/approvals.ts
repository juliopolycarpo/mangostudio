/**
 * Turning Codex's server→client requests into neutral approvals, and turning a
 * chosen option back into the vendor's own response payload.
 *
 * Codex is the only one of the three vendors with a genuine bidirectional
 * approval protocol, which is why it went first: everything here is a real
 * request/response exchange with an id to correlate, not a prompt scraped off a
 * TTY. A pure line reducer could not do this — it has no way to answer — which
 * is the concrete reason plan 003's adapter interface is semantic.
 *
 * Two rules govern every mapping below.
 *
 * **MangoStudio never alters a decision set.** Where the vendor models the
 * answer as an enum, that enum's members *are* the options, with the vendor's
 * own spelling as the option id. Where a member carries a payload MangoStudio
 * has no way to author — an execpolicy amendment, a network policy amendment, a
 * form body matching a JSON Schema — that member is omitted rather than offered
 * with a fabricated value, and the omission is written down here per request
 * kind rather than applied as a filter over something the vendor sent.
 *
 * **`item/tool/call` is refused unconditionally.** See `refuseHostToolCall`.
 */

import type {
  ExternalActivityKind,
  ExternalApprovalOption,
  ExternalApprovalRequest,
} from '@mangostudio/shared/external-agents';
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams';
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams';
import type { McpServerElicitationRequestParams } from './protocol/v2/McpServerElicitationRequestParams';
import type { PermissionsRequestApprovalParams } from './protocol/v2/PermissionsRequestApprovalParams';
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams';

/**
 * How long an unanswered approval stays answerable.
 *
 * Long enough that a person can read a diff and decide; short enough that a
 * forgotten tab does not pin a vendor process forever. The supervisor reads the
 * `expiresAtMs` this produces and stops applying its idle timeout until then,
 * so this number is what keeps a human-paced approval from being killed as a
 * stalled stream.
 */
const CODEX_APPROVAL_TTL_MS = 10 * 60_000;

/** JSON-RPC application error codes this client answers a server request with. */
export const CODEX_ERROR_CODES = {
  /** The method exists in the contract; this client will not serve it. */
  methodNotSupported: -32601,
  /** The method is served, but not for the shape or state that arrived. */
  invalidRequest: -32600,
} as const;

/** Refuse a server request, with the reason the vendor's log will show. */
export interface CodexRequestRefusal {
  readonly outcome: 'refuse';
  readonly code: number;
  readonly message: string;
}

/** Surface an approval and remember how to answer whichever option is chosen. */
export interface CodexRequestApproval {
  readonly outcome: 'approval';
  readonly request: ExternalApprovalRequest;
  /** Builds the JSON-RPC `result` for a chosen option, or throws for an unknown id. */
  encode(optionId: string): unknown;
}

export type CodexServerRequestPlan = CodexRequestApproval | CodexRequestRefusal;

/**
 * The one refusal the core invariant depends on.
 *
 * `item/tool/call` is a server→client request asking **MangoStudio** to execute
 * a tool on Codex's behalf, and `initialize` offers no capability to decline
 * receiving it. It is the single discovered mechanism by which correctly
 * implementing the vendor's protocol would violate the rule the whole cycle
 * serves: external agents use their own tools, and MangoStudio only renders
 * them.
 *
 * So it is answered with an error, always, before anything reads `tool`,
 * `namespace` or `arguments`. There is no allowlist, no configuration and no
 * environment in which this dispatches. The matching `dynamicToolCall` item
 * type still renders, as inert activity, because seeing that Codex asked is
 * useful; acting on it is not.
 */
export function refuseHostToolCall(): CodexRequestRefusal {
  return {
    outcome: 'refuse',
    code: CODEX_ERROR_CODES.methodNotSupported,
    message:
      'MangoStudio hosts Codex; it does not execute tools on its behalf. External agents use their own tools.',
  };
}

function option(id: string, isDestructive: boolean, labelKey: string): ExternalApprovalOption {
  return { id, isDestructive, labelKey };
}

function approvalRequest(
  requestId: string,
  kind: ExternalActivityKind,
  title: string,
  detail: string | undefined,
  options: readonly ExternalApprovalOption[],
  nowMs: number
): ExternalApprovalRequest {
  return {
    requestId,
    kind,
    title,
    ...(detail ? { detail } : {}),
    options,
    expiresAtMs: nowMs + CODEX_APPROVAL_TTL_MS,
  };
}

/**
 * `CommandExecutionApprovalDecision`, minus its two payload-carrying members.
 *
 * `acceptWithExecpolicyAmendment` and `applyNetworkPolicyAmendment` each require
 * composing a policy object that only a client with an execpolicy editor could
 * author. Offering either with an invented payload would answer a question the
 * user was never asked, so they are absent here and Codex simply never sees
 * them chosen.
 */
const COMMAND_OPTIONS: readonly ExternalApprovalOption[] = [
  option('accept', false, 'externalAgents.approval.option.accept'),
  option('acceptForSession', true, 'externalAgents.approval.option.acceptForSession'),
  option('decline', false, 'externalAgents.approval.option.decline'),
  option('cancel', false, 'externalAgents.approval.option.cancel'),
];

/** `FileChangeApprovalDecision` in full — every member is payload-free. */
const FILE_CHANGE_OPTIONS: readonly ExternalApprovalOption[] = [
  option('accept', false, 'externalAgents.approval.option.accept'),
  option('acceptForSession', true, 'externalAgents.approval.option.acceptForSession'),
  option('decline', false, 'externalAgents.approval.option.decline'),
  option('cancel', false, 'externalAgents.approval.option.cancel'),
];

/**
 * `McpServerElicitationAction` minus `accept`.
 *
 * Accepting an elicitation requires `content` conforming to the server's
 * `requestedSchema`, which is a form MangoStudio has no renderer for. Declining
 * and cancelling are the protocol's own ways to say no, so the exchange still
 * completes cleanly rather than failing the MCP call outright.
 */
const ELICITATION_OPTIONS: readonly ExternalApprovalOption[] = [
  option('decline', false, 'externalAgents.approval.option.decline'),
  option('cancel', false, 'externalAgents.approval.option.cancel'),
];

/**
 * Composed rather than passed through, and the only place that is true.
 *
 * `item/permissions/requestApproval` is answered with a grant object rather than
 * an enum, so there is no vendor option list to preserve. What is preserved is
 * the vendor's own scope enum (`turn` | `session`) and the exact profile that
 * was requested: granting means echoing back what Codex asked for, never a
 * widened set MangoStudio assembled.
 */
const PERMISSION_OPTIONS: readonly ExternalApprovalOption[] = [
  option('grant:turn', false, 'externalAgents.approval.option.grantTurn'),
  option('grant:session', true, 'externalAgents.approval.option.grantSession'),
  option('deny', false, 'externalAgents.approval.option.deny'),
];

function requireOption(options: readonly ExternalApprovalOption[], optionId: string): string {
  if (!options.some((candidate) => candidate.id === optionId)) {
    throw new Error(`"${optionId}" is not an option Codex offered for this approval.`);
  }
  return optionId;
}

function commandApproval(
  requestId: string,
  params: CommandExecutionRequestApprovalParams,
  nowMs: number
): CodexRequestApproval {
  const command = params.command ?? '';
  const detail = [params.reason, params.cwd ? `cwd: ${params.cwd}` : undefined]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  return {
    outcome: 'approval',
    request: approvalRequest(
      requestId,
      'command',
      command,
      detail || undefined,
      COMMAND_OPTIONS,
      nowMs
    ),
    encode: (optionId) => ({ decision: requireOption(COMMAND_OPTIONS, optionId) }),
  };
}

function fileChangeApproval(
  requestId: string,
  params: FileChangeRequestApprovalParams,
  nowMs: number
): CodexRequestApproval {
  const detail = [params.reason, params.grantRoot ? `root: ${params.grantRoot}` : undefined]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  return {
    outcome: 'approval',
    request: approvalRequest(
      requestId,
      'file-change',
      params.reason ?? 'File change',
      detail || undefined,
      FILE_CHANGE_OPTIONS,
      nowMs
    ),
    encode: (optionId) => ({ decision: requireOption(FILE_CHANGE_OPTIONS, optionId) }),
  };
}

function permissionsApproval(
  requestId: string,
  params: PermissionsRequestApprovalParams,
  nowMs: number
): CodexRequestApproval {
  const requested = params.permissions;
  const granted = {
    ...(requested.network ? { network: requested.network } : {}),
    ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
  };
  return {
    outcome: 'approval',
    request: approvalRequest(
      requestId,
      'other',
      params.reason ?? 'Additional permissions requested',
      params.cwd ? `cwd: ${params.cwd}` : undefined,
      PERMISSION_OPTIONS,
      nowMs
    ),
    encode: (optionId) => {
      switch (requireOption(PERMISSION_OPTIONS, optionId)) {
        case 'grant:turn':
          return { permissions: granted, scope: 'turn' };
        case 'grant:session':
          return { permissions: granted, scope: 'session' };
        default:
          // Denial is an empty grant at turn scope: nothing is added, and
          // nothing outlives the turn that asked.
          return { permissions: {}, scope: 'turn' };
      }
    },
  };
}

function elicitationApproval(
  requestId: string,
  params: McpServerElicitationRequestParams,
  nowMs: number
): CodexRequestApproval {
  return {
    outcome: 'approval',
    request: approvalRequest(
      requestId,
      'mcp',
      params.serverName,
      params.message,
      ELICITATION_OPTIONS,
      nowMs
    ),
    encode: (optionId) => ({
      action: requireOption(ELICITATION_OPTIONS, optionId),
      content: null,
      _meta: null,
    }),
  };
}

/**
 * `item/tool/requestUserInput` — served only where the neutral contract can
 * carry it faithfully.
 *
 * The vendor asks a *set* of questions, each with its own id, and any of them
 * may be free text or a secret. A neutral approval carries one option list, so
 * the only shape that maps without inventing anything is a single question with
 * an explicit option list. Everything else is refused rather than flattened:
 * silently answering three questions with one click would alter the decision
 * set in the most literal way available.
 *
 * In practice this arrives only for clients that opted into the experimental
 * API, which this one does not.
 */
function userInputApproval(
  requestId: string,
  params: ToolRequestUserInputParams,
  nowMs: number
): CodexServerRequestPlan {
  const [question, ...rest] = params.questions;
  if (!question || rest.length > 0 || question.isSecret || !question.options?.length) {
    return {
      outcome: 'refuse',
      code: CODEX_ERROR_CODES.invalidRequest,
      message:
        'MangoStudio can present a single multiple-choice question; this request needs the vendor’s own input form.',
    };
  }
  const options: readonly ExternalApprovalOption[] = question.options.map((choice, index) => ({
    id: String(index),
    isDestructive: false,
    rawLabel: choice.label,
  }));
  return {
    outcome: 'approval',
    request: approvalRequest(
      requestId,
      'other',
      question.header,
      question.question,
      options,
      nowMs
    ),
    encode: (optionId) => {
      const chosen = options.find((candidate) => candidate.id === optionId);
      const answer = chosen ? question.options?.[Number(chosen.id)]?.label : undefined;
      if (answer === undefined) {
        throw new Error(`"${optionId}" is not an option Codex offered for this approval.`);
      }
      return { answers: { [question.id]: { answers: [answer] } } };
    },
  };
}

/**
 * The complete server→request table, with the fallthrough that matters most.
 *
 * Any method not listed is refused rather than ignored. An unanswered
 * server→client request leaves the vendor blocked on a reply that never comes,
 * so "unknown" has to produce an error frame, not silence.
 */
export function planCodexServerRequest(
  method: string,
  params: unknown,
  requestId: string,
  nowMs: number
): CodexServerRequestPlan {
  switch (method) {
    case 'item/tool/call':
      return refuseHostToolCall();
    case 'item/commandExecution/requestApproval':
      return commandApproval(requestId, params as CommandExecutionRequestApprovalParams, nowMs);
    case 'item/fileChange/requestApproval':
      return fileChangeApproval(requestId, params as FileChangeRequestApprovalParams, nowMs);
    case 'item/permissions/requestApproval':
      return permissionsApproval(requestId, params as PermissionsRequestApprovalParams, nowMs);
    case 'item/tool/requestUserInput':
      return userInputApproval(requestId, params as ToolRequestUserInputParams, nowMs);
    case 'mcpServer/elicitation/request':
      return elicitationApproval(requestId, params as McpServerElicitationRequestParams, nowMs);
    // The v1 approval requests. A v2 client answers them with an error, which
    // is what the vendor expects when the `item/*` forms are in use.
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return {
        outcome: 'refuse',
        code: CODEX_ERROR_CODES.methodNotSupported,
        message: 'This client answers the item/* approval requests, not their v1 predecessors.',
      };
    // Never opted into: `requestAttestation` stays false, and MangoStudio holds
    // no vendor credentials to refresh.
    case 'attestation/generate':
    case 'account/chatgptAuthTokens/refresh':
      return {
        outcome: 'refuse',
        code: CODEX_ERROR_CODES.methodNotSupported,
        message: 'MangoStudio does not hold or mint Codex credentials.',
      };
    default:
      return {
        outcome: 'refuse',
        code: CODEX_ERROR_CODES.methodNotSupported,
        message: `MangoStudio does not implement the "${method}" client method.`,
      };
  }
}
