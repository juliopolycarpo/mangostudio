/**
 * Validates a Direct URL environment `baseUrl` and turns it into the WebSocket
 * URL the hub dials. Private and loopback hosts are allowed — LAN reachability
 * is the point of this transport.
 */

import { RuntimeRemoteError } from '@mangostudio/runtime';

export function parseHttpRuntimeBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RuntimeRemoteError(
      'RUNTIME_UNAVAILABLE',
      `The Direct URL "${baseUrl}" is not a valid URL.`
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RuntimeRemoteError(
      'RUNTIME_UNAVAILABLE',
      `The Direct URL must use http: or https:, not ${url.protocol}`
    );
  }
  return url;
}

/**
 * `http://host:port` → `ws://host:port/`; `https:` → `wss:`. Path and query are
 * preserved so a reverse-proxied root other than `/` still upgrades in place.
 */
export function httpRuntimeBaseUrlToWebSocketUrl(baseUrl: string): string {
  const url = parseHttpRuntimeBaseUrl(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!url.pathname) url.pathname = '/';
  return url.toString();
}
