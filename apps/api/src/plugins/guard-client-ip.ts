/**
 * Derives `guardClientIp`: the address the local-surface guard judges, for the
 * routes that ask whether a caller is at this machine's keyboard.
 *
 * The resolution itself lives in `lib/client-ip`; what this plugin owns is the
 * one place the answer is attached to a request, so a new local-surface route
 * inherits it instead of restating the derive.
 */

import { Elysia } from 'elysia';
import { type GuardIpPolicy, resolveGuardClientIp } from '../lib/client-ip';
import { getConfig } from '../lib/config';

/**
 * Attach the guard's view of the caller's address.
 * // Usage: new Elysia().use(guardClientIp()).get('/x', ({ guardClientIp }) => …)
 */
export function guardClientIp(policy: () => GuardIpPolicy = () => getConfig().security) {
  // Deliberately unnamed: Elysia deduplicates named plugins, and each caller
  // injects its own `policy`. A shared name would silently give the second
  // mount the first one's policy.
  return new Elysia()
    .derive('plugin', ({ request, server }) => {
      // The socket peer is not header-controlled, so it is the default. It is
      // not enough on its own: behind the documented nginx and Caddy setups the
      // peer is always the loopback proxy, and every remote browser would pass
      // a check that is supposed to mean "at this machine's keyboard". Where
      // the operator has trusted the proxy, the hop that proxy appended is the
      // stricter answer; where they have not, a forged header changes nothing.
      return {
        guardClientIp: resolveGuardClientIp(
          request.headers,
          server?.requestIP(request)?.address,
          policy()
        ),
      };
    })
    .as('plugin');
}
