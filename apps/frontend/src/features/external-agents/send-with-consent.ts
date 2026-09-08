/**
 * Running a send that a vendor consent may refuse, and asking the one question
 * that refusal represents.
 *
 * Lives beside the gates that render those questions rather than inside the
 * chat's generation hook, because it is not about generation: it is the rule
 * that a 403 naming a missing consent is a question, asked once, and a second
 * identical 403 is a failure. Both the composer's send and first-run setup's
 * send obey it, and there is one copy of it for the same reason there is one
 * disclosure dialog.
 *
 * // Usage: await sendWithExternalConsent(chatId, () => respondTextStream(body, onChunk));
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import { isExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import { ApiError } from '@/lib/utils';
import { type ExternalDisclosureRequest, promptExternalDisclosure } from './disclosure-prompt';
import { promptExternalWorkspaceTrust } from './workspace-trust-prompt';

/**
 * Runs a send, and gives each answerable refusal one chance to be answered.
 *
 * Both refusals are decided before any of the stream exists — the server answers
 * 403 rather than opening one — so a retry here re-sends a turn that never
 * started rather than resuming one that half did. Exactly one retry per
 * refusal: a second one after the answer was recorded is a real failure, and
 * looping on it would hide it behind a dialog the user keeps answering.
 *
 * The two are checked in sequence rather than in a loop, so a send cannot bounce
 * between them. A turn refused for a workspace and then for a disclosure is a
 * turn that asks the user two separate questions, which is the honest cost of
 * two independent consents; a turn refused twice for the same one is a failure
 * and surfaces as one.
 */
export async function sendWithExternalConsent(
  chatId: string,
  send: () => Promise<void>
): Promise<void> {
  try {
    await send();
  } catch (error) {
    const answered = await answerExternalRefusal(chatId, error);
    if (!answered) throw error;
    try {
      await send();
    } catch (retryError) {
      // The *other* consent, asked once. Reaching here means the first answer
      // was recorded and accepted, and the server then refused for a different
      // reason — a second question, not the same one again.
      const secondAnswer = await answerExternalRefusal(chatId, retryError, answered);
      if (!secondAnswer) throw retryError;
      await send();
    }
  }
}

/**
 * Raises whichever consent dialog this refusal calls for.
 *
 * Returns the kind that was answered, or `undefined` when the error is not an
 * answerable refusal, is the kind already answered on this send, or when the
 * user declined.
 */
async function answerExternalRefusal(
  chatId: string,
  error: unknown,
  already?: 'workspace' | 'disclosure'
): Promise<'workspace' | 'disclosure' | undefined> {
  const scope = untrustedWorkspaceScope(error);
  if (scope && already !== 'workspace') {
    return (await promptExternalWorkspaceTrust({ chatId, ...scope })) ? 'workspace' : undefined;
  }
  const disclosure = requiredDisclosureScope(error);
  if (disclosure && already !== 'disclosure') {
    return (await promptExternalDisclosure(disclosure)) ? 'disclosure' : undefined;
  }
  return undefined;
}

/**
 * The vendor and machine a disclosure refusal named.
 *
 * Both fields or neither: the acknowledgement is stored per vendor and per
 * machine, so a partial scope could only be recorded partially. The chat's own
 * environment is deliberately not used as a fallback — it can differ from the
 * one the refused turn resolved against, and acknowledging the wrong machine
 * would leave the send refused with a consent recorded that nobody asked for.
 */
function requiredDisclosureScope(error: unknown): ExternalDisclosureRequest | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code !== ERROR_CODES.EXTERNAL_DISCLOSURE_REQUIRED) return undefined;
  const { targetId, environmentId } = error.details ?? {};
  if (!targetId || !environmentId || !isExternalAgentTargetId(targetId)) return undefined;
  return { targetId, environmentId };
}

/**
 * The scope a refusal named, or `undefined` when it was some other failure.
 *
 * All three fields or none: the grant is checked against the scope this
 * disclosed, and a partial one could only be checked partially.
 */
function untrustedWorkspaceScope(error: unknown):
  | {
      readonly workspacePath: string;
      readonly targetId: string;
      readonly environmentId: string;
    }
  | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code !== ERROR_CODES.EXTERNAL_WORKSPACE_UNTRUSTED) return undefined;
  const { workspacePath, targetId, environmentId } = error.details ?? {};
  if (!workspacePath || !targetId || !environmentId) return undefined;
  return { workspacePath, targetId, environmentId };
}
