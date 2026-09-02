import { RuntimeServiceManagementError } from '@mangostudio/runtime';

/**
 * Error type for user-facing CLI usage problems (bad flags, invalid ports).
 * The dispatcher prints the message plainly to stderr and exits non-zero.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * Whether an error is already a sentence for the operator, and so should be
 * printed plainly and exited on rather than raised as a stack trace.
 *
 * A service-manager refusal qualifies: it names a missing session bus, an
 * unsupported platform or an over-long task command, and the CLI never
 * branches on its `kind`. Classifying it here rather than wrapping it at each
 * `manager.*` call means a manager call added later is covered by default.
 * // Usage: if (isOperatorError(error)) writeError(error.message);
 */
export function isOperatorError(error: unknown): error is Error {
  return error instanceof CliError || error instanceof RuntimeServiceManagementError;
}
