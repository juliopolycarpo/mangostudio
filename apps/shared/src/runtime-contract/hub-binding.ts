/**
 * The binding key a hub sends in the `serve` upgrade request.
 *
 * A `serve` runtime holds one hub connection at a time. The key names the
 * environment record a connection speaks for, so the runtime can tell that
 * record reconnecting (the new socket supersedes the old one) from a second
 * record pointing at the same runtime (refused with
 * `RUNTIME_ALREADY_BOUND_CLOSE_CODE` while the first is live). It is opaque to
 * the runtime, which validates its shape and compares it for equality.
 */

import Type, { type Static } from 'typebox';
import { HUB_BINDING_KEY_LENGTH } from './strings';

export const HubBindingKeySchema = Type.String({
  pattern: `^[0-9a-f]{${HUB_BINDING_KEY_LENGTH}}$`,
});
export type HubBindingKey = Static<typeof HubBindingKeySchema>;
