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
