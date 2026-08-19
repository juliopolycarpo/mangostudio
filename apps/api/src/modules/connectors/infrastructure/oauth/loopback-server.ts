/**
 * Loopback HTTP server for OAuth redirects, shared by all OAuth connectors.
 *
 * Started lazily per OAuth session on the port fixed by the provider's client
 * registration and torn down on completion, cancellation, or TTL expiry.
 * The only route it serves is the registered callback path; the response is a
 * tiny self-contained HTML page telling the user to close the tab.
 */

export interface OAuthLoopbackServer {
  /**
   * The port the server actually bound. Equal to the registered port in
   * production; tests bind port 0 and read the OS-assigned one back, so the
   * redirect URI they send must be built from this rather than the constant.
   */
  readonly port: number;
  stop(): void;
}

export interface LoopbackServerOptions {
  /** Human-readable provider label used in page copy, e.g. "ChatGPT". */
  providerLabel: string;
  /** Defaults to 127.0.0.1. */
  hostname?: string;
  port: number;
  callbackPath: string;
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
  /** Maps EADDRINUSE to the provider's port-busy error (fixed registered port). */
  createPortBusyError(): Error;
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
 * Binds the loopback address and waits for the OAuth redirect.
 * @throws the profile's port-busy error when the port is already bound.
 */
export function startOAuthLoopbackServer(options: LoopbackServerOptions): OAuthLoopbackServer {
  const failurePage = () =>
    renderPage('Sign-in failed', 'You can close this tab and retry in MangoStudio.');

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== 'GET' || url.pathname !== options.callbackPath) {
          return new Response('Not found', { status: 404, headers: { Connection: 'close' } });
        }

        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          const description = url.searchParams.get('error_description') ?? oauthError;
          options.onFailure(`${options.providerLabel} sign-in was not completed: ${description}`);
          stop();
          return failurePage();
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || state !== options.expectedState) {
          options.onFailure(
            `${options.providerLabel} sign-in callback did not match the pending session.`
          );
          stop();
          return failurePage();
        }

        try {
          await options.onAuthorizationCode(code);
          return renderPage(`Signed in with ${options.providerLabel}`, 'You can close this tab.');
        } catch (error) {
          options.onFailure(
            error instanceof Error
              ? error.message
              : `${options.providerLabel} sign-in failed unexpectedly.`
          );
          return failurePage();
        } finally {
          stop();
        }
      },
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      throw options.createPortBusyError();
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
    // connection would keep the fixed port busy for the next OAuth session.
    server.stop();
    setTimeout(() => server.stop(true), 1_000).unref?.();
  }

  // `Bun.serve` types the port as optional because unix-socket servers have
  // none; a TCP listener always reports one.
  return { port: server.port ?? options.port, stop };
}
