import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { Messages } from '@mangostudio/shared/i18n';
import {
  type TerminalRefusalReason,
  TerminalRefusalReasonSchema,
} from '@mangostudio/shared/terminal';
import { ApiError } from '@/lib/utils';
import { unavailableMessage } from './unavailable-message';

const REFUSAL_REASONS: ReadonlySet<string> = new Set(
  TerminalRefusalReasonSchema.anyOf.map((literal) => literal.const)
);

/** Hub refusals that carry their reason in the error code instead of `details.reason`. */
const REASON_BY_CODE: Readonly<Record<string, TerminalRefusalReason>> = {
  [ERROR_CODES.TERMINAL_DISABLED]: 'disabled',
  [ERROR_CODES.TERMINAL_LIMIT]: 'limit',
  [ERROR_CODES.TERMINAL_NOT_ISOLATED]: 'not-isolated',
};

function refusalReason(error: unknown): TerminalRefusalReason | null {
  if (!(error instanceof ApiError)) return null;
  const detail = error.details?.reason;
  if (detail !== undefined && REFUSAL_REASONS.has(detail)) return detail as TerminalRefusalReason;
  return (error.code && REASON_BY_CODE[error.code]) || null;
}

/**
 * Localizes why opening a terminal failed, worded exactly as the availability
 * view words the same refusal, so a button that could not open a session says
 * what the notice would have said. Anything that is not a recognized hub
 * refusal (a network failure, an unknown reason) gets the generic line.
 *
 * @example
 * openMutation.mutate(body, { onError: (error) => toast(openFailureMessage(t, error), 'error') });
 */
export function openFailureMessage(t: Messages, error: unknown): string {
  const reason = refusalReason(error);
  return reason ? unavailableMessage(t, reason) : t.terminal.openFailed;
}
