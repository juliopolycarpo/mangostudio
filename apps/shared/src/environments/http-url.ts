/**
 * Host-side helpers for Direct URL (`http`) environments: whether a base URL
 * is safe to send without TLS, and the http→ws scheme swap the hub dial uses.
 */

/** Loopback or RFC1918 — hosts that are not reachable from the public internet. */
export function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  // Unique-local IPv6 (fc00::/7) and link-local (fe80::/10).
  if (host.includes(':')) {
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    if (
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when the URL is plaintext HTTP to a host that is not private or
 * loopback — the card warns before storing a token against that address.
 */
export function shouldWarnPlaintextHttpRuntime(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' && !isPrivateOrLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/** Scheme swap used when the hub dials a Direct URL runtime. */
export function httpBaseUrlToWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else throw new Error(`Unsupported Direct URL scheme: ${url.protocol}`);
  if (!url.pathname) url.pathname = '/';
  return url.toString();
}
