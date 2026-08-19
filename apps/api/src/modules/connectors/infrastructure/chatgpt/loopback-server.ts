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

  constructor(port: number = CHATGPT_OAUTH_CALLBACK_PORT) {
    super(
      `Port ${port} is already in use. ` +
        'Close any other ChatGPT sign-in in progress (for example `codex login`) and retry.'
    );
    this.name = 'ChatGptOAuthPortBusyError';
  }
}

export type ChatGptLoopbackServer = OAuthLoopbackServer;

let testPortOverride: number | null = null;

/**
 * Overrides the registered loopback port for tests. The registered port is one
 * machine-wide resource, so every test file that drives the sign-in flow
 * competes for it — with test files running in worker processes the loser gets
 * a spurious `ChatGptOAuthPortBusyError`, and a suite run on a developer's
 * machine collides with a real `codex login`. The test environment passes 0, so
 * each process takes an OS-assigned port; a test that needs a known-busy port
 * passes one it already holds. `null` restores the registered port.
 * // Usage: setChatGptLoopbackPortForTest(0)
 */
export function setChatGptLoopbackPortForTest(port: number | null): void {
  testPortOverride = port;
}

/**
 * Binds 127.0.0.1:1455 and waits for the OAuth redirect. Read the bound port
 * back off the returned server rather than assuming the constant.
 * @throws ChatGptOAuthPortBusyError when the port is already bound.
 */
export function startChatGptLoopbackServer(
  options: Pick<
    LoopbackServerOptions,
    'expectedState' | 'onAuthorizationCode' | 'onFailure' | 'ttlMs'
  >
): ChatGptLoopbackServer {
  const port = testPortOverride ?? CHATGPT_OAUTH_CALLBACK_PORT;
  return startOAuthLoopbackServer({
    ...options,
    providerLabel: 'ChatGPT',
    port,
    callbackPath: CHATGPT_OAUTH_CALLBACK_PATH,
    createPortBusyError: () => new ChatGptOAuthPortBusyError(port),
  });
}
