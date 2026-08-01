/**
 * Whether an environment's transport is safe to hand credentials to.
 *
 * Every other MCP payload is configuration a user typed; secrets are the one
 * thing a passive observer can reuse. A warning is not enough when the
 * credential itself is the payload, so plaintext delivery to a host outside
 * the local network is refused rather than flagged.
 */

import { isLoopbackHostname } from '@mangostudio/runtime';
import type { EnvironmentTransportKind } from '@mangostudio/shared/environments';
import { McpConnectionError } from './types';

/** Refusal to put credentials on a transport that cannot protect them. */
export class McpSecretTransportError extends McpConnectionError {
  constructor(
    readonly serverSlug: string,
    readonly host: string,
    message: string
  ) {
    super(message);
    this.name = 'McpSecretTransportError';
  }
}

export interface McpSecretTransportTarget {
  readonly transportKind: EnvironmentTransportKind;
  readonly config: unknown;
}

/**
 * Refuses secret delivery over a plaintext connection to a host that is not
 * on this machine or this network.
 *
 * Only Direct URL environments can be judged here, and that is not a gap: the
 * hub dials them, so it is the side that chose the scheme. stdio, WSL, and
 * in-process never leave the machine; ssh is encrypted by construction; a
 * dial-in WebSocket runtime chose its own URL, and the hub sees a socket a
 * reverse proxy may already have terminated — guessing from that would be
 * security theatre.
 *
 * // Usage: assertSecretsMayReachEnvironment(server.slug, environment)
 */
export function assertSecretsMayReachEnvironment(
  serverSlug: string,
  target: McpSecretTransportTarget | null
): void {
  if (target?.transportKind !== 'http') return;

  const baseUrl = readBaseUrl(target.config);
  if (!baseUrl) return;

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // An unparseable URL fails at connect with a better message than this one.
    return;
  }
  if (url.protocol !== 'http:' || isLocalNetworkHost(url.hostname)) return;

  throw new McpSecretTransportError(
    serverSlug,
    url.host,
    `MCP server "${serverSlug}" stores secrets, and its environment is reached over plaintext http:// at ${url.host}. ` +
      'Credentials are only delivered over TLS (https://) or to a loopback or private-network address. ' +
      'Put the runtime behind a TLS reverse proxy, or remove the stored secrets from this server.'
  );
}

function readBaseUrl(config: unknown): string | null {
  if (typeof config !== 'object' || config === null) return null;
  const baseUrl = (config as { baseUrl?: unknown }).baseUrl;
  return typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : null;
}

/**
 * Loopback plus the RFC1918 / RFC4193 ranges. A name that is not a literal
 * address cannot be proven local, so it is treated as public: erring the other
 * way would let `http://intranet-host/` carry a token over the office LAN.
 */
function isLocalNetworkHost(hostname: string): boolean {
  if (isLoopbackHostname(hostname)) return true;
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(normalized);
  if (ipv4) {
    const [first, second] = [Number(ipv4[1]), Number(ipv4[2])];
    if (first === 10 || first === 127) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    // Link-local: what a machine gives itself when DHCP never answered.
    if (first === 169 && second === 254) return true;
    return false;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{2}:/.test(normalized) || /^fe[89ab][0-9a-f]:/.test(normalized);
}
