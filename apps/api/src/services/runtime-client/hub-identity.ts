/**
 * Who this hub says it is, for the runtime's audit log.
 *
 * A runtime writes one receipt per method it serves, and the only thing that
 * makes those receipts evidence is the name of the machine that asked. The hub
 * is the side that knows it, so it is the side that says it — on every session,
 * not only the ones a connector remembered to name.
 *
 * The OS is reached through a source rather than `node:os` directly, so a test
 * can hand it a machine that answers, one that answers blank, and one that
 * refuses.
 */

import { hostname, userInfo } from 'node:os';
import type { HubIdentity } from '@mangostudio/shared/runtime-contract';

/** Where the local host and user come from. */
export interface HubIdentitySource {
  hostname(): string;
  username(): string;
}

/** The real machine. */
const nodeHubIdentitySource: HubIdentitySource = {
  hostname: () => hostname(),
  username: () => userInfo().username,
};

/**
 * Best-effort identity for this hub process; absent when the OS will not say.
 *
 * A blank host or user is treated as no answer: an audit line reading `@` names
 * nothing, and the runtime already has a word for a hub that did not identify
 * itself.
 *
 * @example
 * const hub = resolveLocalHubIdentity(); // { host: 'workstation', user: 'ana' }
 */
export function resolveLocalHubIdentity(
  source: HubIdentitySource = nodeHubIdentitySource
): HubIdentity | undefined {
  try {
    const host = source.hostname().trim();
    const user = source.username().trim();
    if (!host || !user) return undefined;
    return { host, user };
  } catch {
    return undefined;
  }
}
