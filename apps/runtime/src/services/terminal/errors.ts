import { RuntimeServiceError } from '../../errors';

/** A `sessionId` the hub named does not exist here, or has already closed. */
export class TerminalNotFoundError extends RuntimeServiceError {
  constructor(sessionId: string) {
    super(
      'terminal_not_found',
      `Terminal session "${sessionId}" was not found; it may have already closed.`,
      { sessionId }
    );
    this.name = 'TerminalNotFoundError';
  }
}

/** A write was sent to a session whose shell has already exited. */
export class TerminalExitedError extends RuntimeServiceError {
  constructor(sessionId: string) {
    super(
      'terminal_exited',
      `Terminal session "${sessionId}" has already exited; write is refused.`,
      { sessionId }
    );
    this.name = 'TerminalExitedError';
  }
}
