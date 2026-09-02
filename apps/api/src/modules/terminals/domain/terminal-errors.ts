/** Typed refusals `terminal-session-service.ts` throws; `terminal-routes.ts` maps them to `ApiErrorResponse`. */

import type { TerminalRefusalReason } from '@mangostudio/shared/terminal';

export class TerminalDisabledError extends Error {
  constructor() {
    super('Live terminals are disabled on this hub.');
    this.name = 'TerminalDisabledError';
  }
}

export class TerminalLimitError extends Error {
  constructor(readonly limit: number) {
    super(`You already hold the maximum of ${limit} running terminal session(s).`);
    this.name = 'TerminalLimitError';
  }
}

/** A terminal on the Local runtime was asked for on a hub with more than one user. */
export class TerminalNotIsolatedError extends Error {
  constructor() {
    super(
      'This hub serves more than one account, so its Local runtime cannot be proven isolated to you.'
    );
    this.name = 'TerminalNotIsolatedError';
  }
}

/** `reason` is always one of the two `UNSUPPORTED` cases the schema documents. */
export class TerminalUnavailableError extends Error {
  constructor(
    readonly reason: Extract<TerminalRefusalReason, 'disconnected' | 'unavailable'>,
    message: string
  ) {
    super(message);
    this.name = 'TerminalUnavailableError';
  }
}

export class TerminalChatNotFoundError extends Error {
  constructor(readonly chatId: string) {
    super(`Chat "${chatId}" was not found.`);
    this.name = 'TerminalChatNotFoundError';
  }
}

export class TerminalChatForbiddenError extends Error {
  constructor(readonly chatId: string) {
    super(`Chat "${chatId}" belongs to another user.`);
    this.name = 'TerminalChatForbiddenError';
  }
}

export class TerminalSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Terminal session "${sessionId}" was not found.`);
    this.name = 'TerminalSessionNotFoundError';
  }
}
