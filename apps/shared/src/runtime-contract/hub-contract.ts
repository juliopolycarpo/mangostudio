/**
 * The hub contract: what a runtime may ask of the hub that connected it.
 *
 * The runtime contract runs hub → runtime. This one runs the other way and
 * carries a single question: may this canonical directory be an external-agent
 * workspace for the user and environment this connection was opened for? The
 * runtime cannot answer that alone. Only the hub knows which chats a user owns.
 *
 * It has its own name and version, so it can evolve apart from
 * `mangostudio.runtime`. Its shapes are closed: an authorization question
 * carrying a member nobody reviewed is refused, not ignored.
 *
 * @example
 * const answer = await session.request(HUB_WORKSPACE_AUTHORIZE_METHOD, {
 *   canonicalPath: '/home/me/project',
 *   purpose: 'external-agent',
 * });
 */

import { defineContract } from '@mangostudio/protocol';
import { type Static, Type } from 'typebox';

/** Contract name for the methods a hub serves to its runtimes. */
export const HUB_CONTRACT_NAME = 'mangostudio.hub';

/** Version of {@link HUB_CONTRACT}; independent of the runtime contract's. */
export const HUB_CONTRACT_VERSION = '1.0.0';

/** The one method a runtime calls before admitting an external-agent workspace. */
export const HUB_WORKSPACE_AUTHORIZE_METHOD = 'hub.workspace.authorize';

/** Longest canonical path the hub accepts, matching the runtime's own bound. */
export const HUB_WORKSPACE_PATH_MAX_LENGTH = 4096;

export const HubWorkspaceAuthorizeParamsSchema = Type.Object(
  {
    canonicalPath: Type.String({ minLength: 1, maxLength: HUB_WORKSPACE_PATH_MAX_LENGTH }),
    purpose: Type.Literal('external-agent'),
  },
  { additionalProperties: false }
);
export type HubWorkspaceAuthorizeParams = Static<typeof HubWorkspaceAuthorizeParamsSchema>;

export const HubWorkspaceAuthorizeResultSchema = Type.Object(
  { authorized: Type.Boolean() },
  { additionalProperties: false }
);
export type HubWorkspaceAuthorizeResult = Static<typeof HubWorkspaceAuthorizeResultSchema>;

/**
 * The hub contract definition. Serve it on every hub session with
 * `HUB_CONTRACT.serve(session, handlers, { discover: false })`.
 *
 * @example
 * HUB_CONTRACT.serve(session, { 'hub.workspace.authorize': () => ({ authorized: false }) });
 */
export const HUB_CONTRACT = defineContract({
  name: HUB_CONTRACT_NAME,
  version: HUB_CONTRACT_VERSION,
  description: 'What a MangoStudio runtime may ask of the hub that connected it.',
  methods: {
    [HUB_WORKSPACE_AUTHORIZE_METHOD]: {
      params: HubWorkspaceAuthorizeParamsSchema,
      result: HubWorkspaceAuthorizeResultSchema,
      capabilities: [],
      description:
        'Whether a canonical directory may be an external-agent workspace for the user and environment this connection is bound to.',
    },
  },
});
