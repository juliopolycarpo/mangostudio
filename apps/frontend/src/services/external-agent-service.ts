/**
 * The client's side of an external agent turn: discovery, approvals, forking.
 *
 * Nothing here decides anything. Discovery answers what a machine has, the
 * approval post carries the option id the user pressed, and the fork asks the
 * server to make the new chat D14 requires. Every check that matters — the
 * approval binding, the permission pair, the runner kind — is the server's.
 */

import type { Chat, ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { ExternalAgentDescriptorListResponse } from '@mangostudio/shared/external-agents';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export interface AnswerExternalApprovalBody {
  readonly requestId: string;
  readonly optionId: string;
}

/** What the server did with the answer. `rejected` is a fact, not an exception. */
export interface AnswerExternalApprovalResult {
  readonly status: 'accepted' | 'rejected';
  readonly optionId?: string;
  readonly reason?: string;
}

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
  const { data, error } = await client.api
    .chats({ id: chatId })
    ['external-agent'].respond.post(body);
  if (error) {
    const value = error.value as AnswerExternalApprovalResult | { error?: string } | null;
    if (value && 'status' in value && value.status === 'rejected') return value;
    throw new ApiError(error.value);
  }
  return data as AnswerExternalApprovalResult;
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
  const { data, error } = await client.api
    .chats({ id: chatId })
    ['fork-with-runner'].post({ runner });
  if (error) throw new ApiError(error.value);
  return (data as { chat: Chat }).chat;
}

/**
 * Records that this vendor may load the chat workspace's own configuration.
 *
 * No path is sent. The server re-derives the canonical directory the same way
 * the turn does, on the machine that actually runs the vendor, so the string it
 * stores is the string the next check reads — and a client cannot widen the
 * grant by spelling a directory differently.
 */
export async function trustExternalWorkspace(chatId: string): Promise<string> {
  const { data, error } = await client.api
    .chats({ id: chatId })
    ['external-agent']['trust-workspace'].post();
  if (error) throw new ApiError(error.value);
  return (data as { workspacePath: string }).workspacePath;
}
