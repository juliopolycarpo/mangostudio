/**
 * The hub's answer to `hub.workspace.authorize`: may this canonical directory
 * be an external-agent workspace for the connection that asks?
 *
 * One policy for every transport. A workspace is authorized only when a chat
 * owned by the connection's user, on the connection's environment, has exactly
 * that `workdir`. The binding comes from the hub's own record of the
 * connection, never from the runtime, so a runtime cannot ask on another
 * user's or another environment's behalf.
 */

import type { HandlerContext, Session } from '@mangostudio/protocol';
import {
  HUB_CONTRACT,
  HUB_WORKSPACE_AUTHORIZE_METHOD,
  type HubWorkspaceAuthorizeParams,
  type HubWorkspaceAuthorizeResult,
} from '@mangostudio/shared/runtime-contract';
import { getDb } from '../../db/database';
import { raceAgainstAbort } from '../../lib/abort-race';

/** Who a hub session speaks for, as the hub recorded it when it opened. */
export interface HubWorkspaceBinding {
  readonly userId: string;
  readonly environmentId: string;
}

/**
 * The user id CLI and setup probes run under when no authenticated user
 * exists. It owns no chats, so it can never authorize a workspace.
 */
export const STAND_IN_USER_ID = 'local';

/** Answers whether `binding` may use `canonicalPath`; injectable for tests. */
export type EnvironmentWorkspacePolicy = (
  binding: HubWorkspaceBinding,
  canonicalPath: string,
  signal: AbortSignal
) => Promise<boolean>;

/**
 * Whether a chat owned by `binding.userId` on `binding.environmentId` has
 * `workdir` exactly equal to `canonicalPath`. Refuses the stand-in user and an
 * empty binding without reading the database. Rejects when `signal` aborts.
 *
 * @example
 * const allowed = await isAuthorizedEnvironmentWorkspace(
 *   { userId: 'u1', environmentId: 'devbox' },
 *   '/home/me/project',
 *   AbortSignal.timeout(5_000)
 * );
 */
export async function isAuthorizedEnvironmentWorkspace(
  binding: HubWorkspaceBinding,
  canonicalPath: string,
  signal: AbortSignal
): Promise<boolean> {
  if (!isRealBinding(binding) || canonicalPath.length === 0) return false;
  signal.throwIfAborted();
  const query = getDb()
    .selectFrom('chats')
    .select('id')
    .where('userId', '=', binding.userId)
    .where('environmentId', '=', binding.environmentId)
    .where('workdir', '=', canonicalPath)
    .limit(1)
    .executeTakeFirst();
  const chat = await raceAgainstAbort(query, signal, () =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error('Workspace authorization was cancelled.')
  );
  signal.throwIfAborted();
  return chat !== undefined;
}

function isRealBinding(binding: HubWorkspaceBinding): boolean {
  return (
    binding.userId.length > 0 &&
    binding.userId !== STAND_IN_USER_ID &&
    binding.environmentId.length > 0
  );
}

/**
 * The `hub.workspace.authorize` handler for one connection. `null` is a
 * connection with no bound user; it answers `authorized: false` to everything.
 * Params reach it only after the contract validated them.
 *
 * @example
 * const handler = createHubWorkspaceAuthorizeHandler({ userId: 'u1', environmentId: 'devbox' });
 */
export function createHubWorkspaceAuthorizeHandler(
  binding: HubWorkspaceBinding | null,
  policy: EnvironmentWorkspacePolicy = isAuthorizedEnvironmentWorkspace
): (
  params: HubWorkspaceAuthorizeParams,
  context: HandlerContext
) => Promise<HubWorkspaceAuthorizeResult> {
  return async (params, context) => {
    if (!binding || !isRealBinding(binding)) return { authorized: false };
    return { authorized: await policy(binding, params.canonicalPath, context.signal) };
  };
}

/**
 * Serves the hub contract on `session` for `binding`. Params the contract
 * refuses are answered `INVALID_PARAMS` before the policy runs.
 * `rpc.discover` stays unserved: the hub session never advertised a catalog,
 * and a runtime fails closed on `METHOD_UNSUPPORTED` anyway.
 *
 * @example
 * const stop = serveHubContract(session, { userId: 'u1', environmentId: 'devbox' });
 */
export function serveHubContract(
  session: Session,
  binding: HubWorkspaceBinding | null,
  policy?: EnvironmentWorkspacePolicy
): () => void {
  return HUB_CONTRACT.serve(
    session,
    { [HUB_WORKSPACE_AUTHORIZE_METHOD]: createHubWorkspaceAuthorizeHandler(binding, policy) },
    { discover: false }
  );
}
