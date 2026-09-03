/**
 * The refusal every environment service speaks.
 *
 * It lives in the domain rather than beside one service because more than one
 * of them raises it, and routing it through whichever service happened to
 * declare it first is what turns a shared vocabulary into an import cycle.
 */

export class EnvironmentServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 503
  ) {
    super(message);
    this.name = 'EnvironmentServiceError';
  }
}
