/**
 * ChatGPT binding for the shared OAuth loopback server: the fixed port and
 * callback path from OpenAI's client registration plus the ChatGPT-specific
 * port-busy error.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import {
  type LoopbackServerOptions,
  type OAuthLoopbackServer,
  startOAuthLoopbackServer,
} from '../oauth/loopback-server';
import { CHATGPT_OAUTH_CALLBACK_PATH, CHATGPT_OAUTH_CALLBACK_PORT } from './oauth-constants';

/** The fixed loopback port is already bound (commonly a running `codex login`). */
export class ChatGptOAuthPortBusyError extends Error {
  readonly code = ERROR_CODES.PROVIDER_ERROR;
  readonly status = 503;

  constructor() {
    super(
      `Port ${CHATGPT_OAUTH_CALLBACK_PORT} is already in use. ` +
        'Close any other ChatGPT sign-in in progress (for example `codex login`) and retry.'
    );
    this.name = 'ChatGptOAuthPortBusyError';
  }
}

export type ChatGptLoopbackServer = OAuthLoopbackServer;

/**
 * Binds 127.0.0.1:1455 and waits for the OAuth redirect.
 * @throws ChatGptOAuthPortBusyError when the port is already bound.
 */
export function startChatGptLoopbackServer(
  options: Pick<
    LoopbackServerOptions,
    'expectedState' | 'onAuthorizationCode' | 'onFailure' | 'ttlMs'
  >
): ChatGptLoopbackServer {
  return startOAuthLoopbackServer({
    ...options,
    providerLabel: 'ChatGPT',
    port: CHATGPT_OAUTH_CALLBACK_PORT,
    callbackPath: CHATGPT_OAUTH_CALLBACK_PATH,
    createPortBusyError: () => new ChatGptOAuthPortBusyError(),
  });
}
