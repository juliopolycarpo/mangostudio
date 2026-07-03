/**
 * Loopback HTTP server for the ChatGPT OAuth redirect.
 *
 * Started lazily per OAuth session on the port fixed by OpenAI's client
 * registration and torn down on completion, cancellation, or TTL expiry.
 * The only route it serves is the registered callback path; the response is a
 * tiny self-contained HTML page telling the user to close the tab.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
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

export interface ChatGptLoopbackServer {
  stop(): void;
}

export interface LoopbackServerOptions {
  expectedState: string;
  /**
   * Invoked with the authorization code once the state matches. A resolved
   * promise renders the success page; a rejection renders the failure page.
   */
  onAuthorizationCode(code: string): Promise<void>;
  /** Invoked when the callback carries an OAuth error or a state mismatch. */
  onFailure(message: string): void;
  /** Hard TTL after which the server closes itself. */
  ttlMs: number;
}

// Every response closes its connection: the server is single-use, and a
// lingering keep-alive connection would delay releasing the fixed port for
// the next OAuth session.
function renderPage(title: string, detail: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>MangoStudio</title></head>` +
      `<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh">` +
      `<div style="text-align: center"><h1>${title}</h1><p>${detail}</p></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' } }
  );
}

/**
 * Binds 127.0.0.1:1455 and waits for the OAuth redirect.
 * @throws ChatGptOAuthPortBusyError when the port is already bound.
 */
export function startChatGptLoopbackServer(options: LoopbackServerOptions): ChatGptLoopbackServer {
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: CHATGPT_OAUTH_CALLBACK_PORT,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== 'GET' || url.pathname !== CHATGPT_OAUTH_CALLBACK_PATH) {
          return new Response('Not found', { status: 404, headers: { Connection: 'close' } });
        }

        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          const description = url.searchParams.get('error_description') ?? oauthError;
          options.onFailure(`ChatGPT sign-in was not completed: ${description}`);
          stop();
          return renderPage('Sign-in failed', 'You can close this tab and retry in MangoStudio.');
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || state !== options.expectedState) {
          options.onFailure('ChatGPT sign-in callback did not match the pending session.');
          stop();
          return renderPage('Sign-in failed', 'You can close this tab and retry in MangoStudio.');
        }

        try {
          await options.onAuthorizationCode(code);
          return renderPage('Signed in with ChatGPT', 'You can close this tab.');
        } catch (error) {
          options.onFailure(
            error instanceof Error ? error.message : 'ChatGPT sign-in failed unexpectedly.'
          );
          return renderPage('Sign-in failed', 'You can close this tab and retry in MangoStudio.');
        } finally {
          stop();
        }
      },
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      throw new ChatGptOAuthPortBusyError();
    }
    throw error;
  }

  const ttlTimer = setTimeout(stop, options.ttlMs);
  ttlTimer.unref?.();

  let stopped = false;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(ttlTimer);
    // Stop listening immediately, but let the in-flight callback response
    // flush before force-closing lingering keep-alive connections — a held
    // connection would keep port 1455 busy for the next OAuth session.
    server.stop();
    setTimeout(() => server.stop(true), 1_000).unref?.();
  }

  return { stop };
}
