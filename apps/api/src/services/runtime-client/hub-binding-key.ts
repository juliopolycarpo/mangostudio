/**
 * The binding key this hub announces for one environment record.
 *
 * Sent in the `serve` upgrade request (`HUB_BINDING_KEY_HEADER`). A `serve`
 * runtime holds one hub connection at a time and compares this key to tell the
 * same record reconnecting (supersede the old socket) from a second record
 * pointing at the same runtime (refused while the first is live). The runtime
 * only compares it, so it is a digest rather than the ids themselves: nothing
 * about the hub's users or records needs to reach another machine.
 */

import { createHash } from 'node:crypto';
import type { HubBindingKey } from '@mangostudio/shared/runtime-contract';
import type { HubWorkspaceBinding } from './hub-workspace-authority';

/** Versioned so a future change of derivation never collides with this one. */
const DOMAIN = 'mangostudio.hub-binding.v1';

/**
 * A stable, opaque key for `binding`: the same record always derives the same
 * key, and two records never share one.
 *
 * @example
 * hubBindingKeyFor({ userId: 'u1', environmentId: 'lan-box' }); // 64 hex characters
 */
export function hubBindingKeyFor(binding: HubWorkspaceBinding): HubBindingKey {
  return createHash('sha256')
    .update(`${DOMAIN}\0${binding.userId}\0${binding.environmentId}`)
    .digest('hex');
}
