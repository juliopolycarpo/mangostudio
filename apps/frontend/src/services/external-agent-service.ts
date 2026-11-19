/**
 * The client's side of an external agent turn: discovery, approvals, forking.
 *
 * Nothing here decides anything. Discovery answers what a machine has, the
 * approval post carries the option id the user pressed, and the fork asks the
 * server to make the new chat D14 requires. Every check that matters — the
 * approval binding, the permission pair, the runner kind — is the server's.
 */

import type { Chat, ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type {
  ExternalAgentCommandCatalogResponse,
  ExternalAgentDescriptorListResponse,
  ExternalApprovalAnswerResult,
  ExternalNativeSession,
  ExternalNativeSessionListResponse,
  ExternalSteerResponse,
  ExternalWorkspaceTrust,
  ExternalWorkspaceTrustListResponse,
  ExternalWorkspaceTrustRevokeBody,
} from '@mangostudio/shared/external-agents';

import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export interface AnswerExternalApprovalBody {
  readonly requestId: string;
  readonly optionId: string;
}

/** What the server did with the answer. `rejected` is a fact, not an exception. */
export type AnswerExternalApprovalResult = ExternalApprovalAnswerResult;

export async function listExternalAgents(
  environmentId: string
): Promise<ExternalAgentDescriptorListResponse> {
  const { data, error } = await client.api['external-agents'].get({ query: { environmentId } });
  if (error) throw new ApiError(error.value);
  return data as ExternalAgentDescriptorListResponse;
}

/**
 * Answers a pending approval.
 *
 * A rejection is returned rather than thrown: "this approval expired while you
 * were reading it" is something the card has to render, and the failure arm is
 * for a request that never reached the server at all.
 */
export async function answerExternalApproval(
  chatId: string,
  body: AnswerExternalApprovalBody
): Promise<AnswerExternalApprovalResult> {
  const chat = client.api.chats({ id: chatId });
  const { data, error } = await chat['external-agent'].respond.post(body);
  if (error) {
    // The route's 400, 404 and 409 are the rejection; anything else (401, 422,
    // 500) is a failure and throws.
    if (error.status === 400 || error.status === 404 || error.status === 409) return error.value;
    throw new ApiError(error.value);
  }
  return data;
}

/**
 * Sends more input into a chat's currently running turn. Codex only.
 *
 * A rejection is returned rather than thrown, exactly like
 * {@link answerExternalApproval}: "that turn already finished" is something
 * the composer has to render, not an exception. So is
 * `{ accepted: false, deliveryUnknown: true }`, which the hub answers with a
 * 200 when it cannot tell whether the agent got the steer. The failure arm is
 * for a request that never reached the server at all.
 */
export async function steerExternalTurn(
  chatId: string,
  body: { readonly clientMessageId: string; readonly text: string }
): Promise<ExternalSteerResponse> {
  const { data, error } = await client.api.chats({ id: chatId })['external-agent'].steer.post(body);
  if (error) {
    // The 409 is the refusal; the 200 below is accepted or delivery-unknown.
    if (error.status === 409) return error.value;
    throw new ApiError(error.value);
  }
  return data;
}

/**
 * Continues in a new chat under a different runner kind (D14).
 *
 * The new chat carries environment and workdir and no transcript. That is not a
 * limitation to route around: a transcript that mixed owners would replay a
 * vendor's assistant text to MangoStudio's own model as its own prior output.
 */
export async function forkChatWithRunner(
  chatId: string,
  runner: ChatRunnerConfiguration
): Promise<Chat> {
  const chat = client.api.chats({ id: chatId });
  const { data, error } = await chat['fork-with-runner'].post({ runner });
  if (error) throw new ApiError(error.value);
  return (data as { chat: Chat }).chat;
}

/**
 * Records that this vendor may load the chat workspace's own configuration.
 *
 * The scope travels as an expectation, never as an input. The server re-derives
 * every value it stores from the chat — the canonical directory on the machine
 * that actually runs the vendor — so a client cannot widen the grant by spelling
 * a directory differently. What the body does is let the server refuse when the
 * chat no longer resolves to the scope the user was shown.
 */
export async function trustExternalWorkspace(
  chatId: string,
  scope: {
    readonly workspacePath: string;
    readonly targetId: string;
    readonly environmentId: string;
  }
): Promise<string> {
  const chat = client.api.chats({ id: chatId });
  const { data, error } = await chat['external-agent']['trust-workspace'].post(scope);
  if (error) throw new ApiError(error.value);
  return (data as { workspacePath: string }).workspacePath;
}

/** Every folder the user has trusted a vendor to load configuration from. */
export async function listExternalWorkspaceTrust(): Promise<readonly ExternalWorkspaceTrust[]> {
  const { data, error } = await client.api['external-agents']['workspace-trust'].get();
  if (error) throw new ApiError(error.value);
  return (data as ExternalWorkspaceTrustListResponse).grants;
}

/**
 * Withdraws one grant, named by the key the list returned it under.
 *
 * The path goes back exactly as listed: the server matches the stored string and
 * never re-spells it. A turn already running is not stopped; the next one in that
 * folder asks again.
 */
export async function revokeExternalWorkspaceTrust(
  grant: ExternalWorkspaceTrustRevokeBody
): Promise<void> {
  const { error } = await client.api['external-agents']['workspace-trust'].delete({
    targetId: grant.targetId,
    environmentId: grant.environmentId,
    workspacePath: grant.workspacePath,
  });
  if (error) throw new ApiError(error.value);
}

/**
 * The vendor's own sessions on one machine.
 *
 * Rows are pointers, not transcripts: nothing here carries conversation
 * content, and adopting one records which vendor conversation a new chat
 * continues rather than copying it into MangoStudio.
 */
export async function listExternalNativeSessions(query: {
  readonly environmentId: string;
  readonly targetId: string;
  readonly workspacePath?: string;
  readonly cursor?: string;
}): Promise<ExternalNativeSessionListResponse> {
  const { data, error } = await client.api['external-agents'].sessions.get({
    query: {
      environmentId: query.environmentId,
      targetId: query.targetId,
      ...(query.workspacePath ? { workspacePath: query.workspacePath } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    },
  });
  if (error) throw new ApiError(error.value);
  return data as ExternalNativeSessionListResponse;
}

/**
 * Continues a native session in a new chat.
 *
 * The row is sent back exactly as it was rendered. The server re-reads the
 * session before it creates anything and refuses when the answer differs, so a
 * session deleted or written to since the picker loaded produces an error and
 * no chat — never a silently empty conversation.
 */
export async function adoptExternalSession(input: {
  readonly environmentId: string;
  readonly session: ExternalNativeSession;
}): Promise<Chat> {
  const { data, error } = await client.api.chats['adopt-external-session'].post({
    environmentId: input.environmentId,
    session: input.session,
  });
  if (error) throw new ApiError(error.value);
  return (data as { chat: Chat }).chat;
}

/** One vendor the user has been shown the third-party notice for. */
export interface ExternalDisclosureRecord {
  readonly targetId: string;
  readonly disclosureVersion: number;
  readonly acknowledgedAt: number;
}

export async function listExternalDisclosures(): Promise<readonly ExternalDisclosureRecord[]> {
  const { data, error } = await client.api['external-agents'].disclosures.get();
  if (error) throw new ApiError(error.value);
  return (data as { disclosures: ExternalDisclosureRecord[] }).disclosures;
}

/**
 * Records the acknowledgement server-side.
 *
 * The body carries no fingerprint on purpose. What the user agreed to is
 * whatever the descriptor for `environmentId` says the agent can do, and the
 * server derives that itself — a client that could supply its own would be able
 * to acknowledge a disclosure it was never shown.
 */
export async function acknowledgeExternalDisclosure(
  targetId: string,
  environmentId: string
): Promise<void> {
  const { error } = await client.api['external-agents']({ targetId }).disclosure.post(undefined, {
    query: { environmentId },
  });
  if (error) throw new ApiError(error.value);
}

/** Withdraws it, which also stops whatever is running for this user right now. */
export async function revokeExternalDisclosure(targetId: string): Promise<void> {
  const { error } = await client.api['external-agents']({ targetId }).disclosure.delete();
  if (error) throw new ApiError(error.value);
}

export async function getExternalAccountLimits(
  targetId: string,
  query: { environmentId: string; vendorAccountFingerprint?: string }
): Promise<{ limits?: import('@mangostudio/shared/external-agents').ExternalAccountLimits }> {
  const { data, error } = await client.api['external-agents']({ targetId })['account-limits'].get({
    query: {
      environmentId: query.environmentId,
      ...(query.vendorAccountFingerprint
        ? { vendorAccountFingerprint: query.vendorAccountFingerprint }
        : {}),
    },
  });
  if (error) throw new ApiError(error.value);
  return data as { limits?: import('@mangostudio/shared/external-agents').ExternalAccountLimits };
}

export async function refreshExternalAccountLimits(
  targetId: string,
  query: { environmentId: string; vendorAccountFingerprint?: string }
): Promise<{ limits?: import('@mangostudio/shared/external-agents').ExternalAccountLimits }> {
  const { data, error } = await client.api['external-agents']({ targetId })[
    'account-limits'
  ].refresh.post(undefined, {
    query: {
      environmentId: query.environmentId,
      ...(query.vendorAccountFingerprint
        ? { vendorAccountFingerprint: query.vendorAccountFingerprint }
        : {}),
    },
  });
  if (error) throw new ApiError(error.value);
  return data as { limits?: import('@mangostudio/shared/external-agents').ExternalAccountLimits };
}

/**
 * The last catalog the hub observed for this (user, environment, target), for
 * a reload before this chat's own first turn re-announces one of its own. An
 * empty `commands` array means nothing has ever been observed, not a failure.
 */
export async function getExternalCommandCatalog(
  targetId: string,
  query: { environmentId: string }
): Promise<ExternalAgentCommandCatalogResponse> {
  const { data, error } = await client.api['external-agents']({ targetId }).commands.get({
    query: { environmentId: query.environmentId },
  });
  if (error) throw new ApiError(error.value);
  return data as ExternalAgentCommandCatalogResponse;
}
