/**
 * `@mangostudio/protocol/ws`: the WebSocket transport of
 * spec/transports/websocket.md.
 *
 * Browser-safe, like the core entry: nothing reachable from here imports
 * `node:` or a runtime-specific module. A server framework builds a port from
 * a sink with `createWebSocketPort`; a dialler uses `connectWebSocket`; either
 * side can wrap an open WHATWG socket with `webSocketPort`.
 */

export {
  createWebSocketPort,
  isOriginAllowed,
  outcomeOfBunSend,
  type SendOutcome,
  WEBSOCKET_SUBPROTOCOL,
  type WebSocketPortHandle,
  type WebSocketPortOptions,
  type WebSocketSink,
} from './transports/websocket';
export {
  type ConnectWebSocketOptions,
  connectWebSocket,
  type WhatwgWebSocketLike,
  webSocketPort,
} from './transports/websocket-client';
