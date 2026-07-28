/**
 * Client-fault failures of the propagation flow, carrying the status the route
 * should return. Lives in `domain` so the preview and the conflict-resolution
 * service can both raise it without importing each other.
 */
export type PropagationErrorStatus = 400 | 404 | 409 | 422;

export class PropagationRequestError extends Error {
  constructor(
    readonly status: PropagationErrorStatus,
    message: string
  ) {
    super(message);
    this.name = 'PropagationRequestError';
  }
}
