/**
 * The binding key a hub announces beside `hub` in its `hello.capabilities`.
 *
 * A `serve` runtime holds one hub connection at a time. The key names the
 * environment record a connection speaks for, so the runtime can tell that
 * record reconnecting (the new socket supersedes the old one) from a second
 * record pointing at the same runtime (refused with
 * `RUNTIME_ALREADY_BOUND_CLOSE_CODE` while the first is live). It is opaque to
 * the runtime, which only compares it for equality.
 */

import Type, { type Static } from 'typebox';
import Value from 'typebox/value';
import { HUB_BINDING_KEY_CAPABILITY, HUB_BINDING_KEY_MAX_LENGTH } from './strings';

export const HubBindingKeySchema = Type.String({
  minLength: 1,
  maxLength: HUB_BINDING_KEY_MAX_LENGTH,
});
export type HubBindingKey = Static<typeof HubBindingKeySchema>;

/**
 * The hub's binding key from its `hello.capabilities`, or undefined when it
 * announced none or one this build cannot compare.
 *
 * @example
 * hubBindingKeyOf({ bindingKey: 'a1b2' }); // 'a1b2'
 */
export function hubBindingKeyOf(
  capabilities: Readonly<Record<string, unknown>>
): HubBindingKey | undefined {
  const key = capabilities[HUB_BINDING_KEY_CAPABILITY];
  return Value.Check(HubBindingKeySchema, key) ? key : undefined;
}
