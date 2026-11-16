/**
 * Lets a request be silent while its handler works.
 *
 * Bun resets a connection that sends no bytes for the listener's idle timeout
 * (10 s, see `lib/hub-connection-limits`). That timeout is there to shed slow
 * clients, but once a request has been received and its handler is running, the
 * silence is the hub's own: a slow `git push` or an installer download would
 * end in ECONNRESET while the work carried on. So for exactly the span of the
 * handler this plugin gives the request `HUB_HANDLER_IDLE_TIMEOUT_SECONDS`, and
 * every route that runs under it is covered without declaring anything.
 *
 * The extension is only granted once the body is out of the client's hands:
 * a request with no body, or one Elysia has already read and validated before
 * `beforeHandle`. A request that still has unread body bytes keeps the
 * listener's 10 s, so a client that declares a body and never sends it, or
 * trickles it, is cut as before. That matters on a route registered with
 * `parse: 'none'` (the Better Auth passthrough), whose handler reads the body
 * itself after this hook. The check is on the request, not the path, so any
 * such route is covered. The timeout goes back to 10 s once the handler has its
 * response (or has thrown), so a client that stops reading a large answer is
 * shed as before, and an SSE stream, whose handler returns its `Response` at
 * once, still depends on its keepalive.
 *
 * Mounted once on the `/api` instance in `app.ts`; the frontend assets are
 * served by the outer app and keep the listener's timeout.
 */

import { Elysia } from 'elysia';

import {
  HUB_HANDLER_IDLE_TIMEOUT_SECONDS,
  HUB_IDLE_TIMEOUT_SECONDS,
} from '../lib/hub-connection-limits';

interface TimeoutCapableServer {
  timeout(request: Request, seconds: number): void;
}

/** A websocket upgrade has its own idle policy, set with the websocket options. */
function isUpgrade(request: Request): boolean {
  return request.headers.has('upgrade');
}

interface HookContext {
  request: Request;
  server: TimeoutCapableServer | null;
}

/**
 * True while body bytes may still be on their way from the client: Bun gives a
 * body-carrying request a stream, and Elysia marks it used once it has parsed
 * it. GET, HEAD and an empty POST have no stream (`null`). A body Elysia did not
 * parse because the route never declared one also reads as unread, which only
 * keeps that request on the listener's own timeout, as before this plugin.
 */
function hasUnreadBody(request: Request): boolean {
  return request.body !== null && !request.bodyUsed;
}

function setIdleTimeout({ request, server }: HookContext, seconds: number): void {
  // `server` is null under `app.handle()`, which has no socket to extend.
  if (!server || isUpgrade(request)) return;
  server.timeout(request, seconds);
}

function extendForHandler(context: HookContext): void {
  if (hasUnreadBody(context.request)) return;
  setIdleTimeout(context, HUB_HANDLER_IDLE_TIMEOUT_SECONDS);
}

// `plugin` scope reaches every route of the instance that mounts this, child
// plugins included, but not the routes the outer app adds after mounting it:
// `global` would also extend the uploaded-file and frontend asset routes.
export const handlerIdleTimeout = new Elysia({ name: 'handler-idle-timeout' })
  .onBeforeHandle('plugin', extendForHandler)
  .onAfterHandle('plugin', (context: HookContext) =>
    setIdleTimeout(context, HUB_IDLE_TIMEOUT_SECONDS)
  )
  .onError('plugin', (context: HookContext) => setIdleTimeout(context, HUB_IDLE_TIMEOUT_SECONDS));
