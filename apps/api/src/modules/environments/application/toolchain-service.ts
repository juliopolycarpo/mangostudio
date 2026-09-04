/**
 * Resolves and updates which Node and Bun every process spawned on one
 * environment runs with.
 *
 * A path choice is validated against what the environment's own probe already
 * found — an arbitrary directory must never reach a PATH prefix the runtime
 * spawns a process with, so `update` never stores a value `resolve` cannot
 * trace back to an installation the machine reported.
 */

import type {
  RuntimeId,
  ToolchainChoice,
  ToolchainSelection,
  ToolchainUpdateBody,
} from '@mangostudio/shared/environments';
import {
  DEFAULT_TOOLCHAIN_SELECTION,
  TOOLCHAIN_RUNTIME_IDS,
} from '@mangostudio/shared/environments';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { publishEnvironmentInvalidation } from '../../../services/realtime/environment-invalidation';
import { EnvironmentServiceError } from '../domain/environment-error';
import {
  type EnvironmentToolchainRepository,
  environmentToolchainRepository,
} from '../infrastructure/environment-toolchain-repository';
import { type EnvironmentProbingService, environmentProbingService } from './probing-service';

export interface ToolchainService {
  resolve(userId: string, environmentId: string): Promise<ToolchainSelection>;
  update(
    userId: string,
    environmentId: string,
    body: ToolchainUpdateBody
  ): Promise<ToolchainSelection>;
}

/**
 * The `toolchain` field a spawn request may carry, or nothing at all.
 *
 * Every spawn method validates its params strictly, so a peer that predates
 * the selection refuses a request naming it outright — the field must be
 * omitted, not sent empty. Spelling that rule at each spawn site is how a
 * fifth one comes to forget it, so it lives here instead.
 * // Usage: { ...toolchainParams(client.manifest, command.toolchain) }
 */
export function toolchainParams(
  manifest: RuntimeCapabilityManifest,
  selection: ToolchainSelection | undefined
): { toolchain?: ToolchainSelection } {
  if (manifest.features.toolchain !== true || !selection) return {};
  return { toolchain: selection };
}

/**
 * {@link toolchainParams} for a caller that has not read the selection yet:
 * a peer that cannot accept one is never asked to resolve it, so a legacy
 * runtime costs no lookup per spawn.
 * // Usage: await resolveToolchainParams(client.manifest, () => toolchainService.resolve(userId, environmentId))
 */
export async function resolveToolchainParams(
  manifest: RuntimeCapabilityManifest,
  resolve: () => Promise<ToolchainSelection | undefined>
): Promise<{ toolchain?: ToolchainSelection }> {
  if (manifest.features.toolchain !== true) return {};
  return toolchainParams(manifest, await resolve());
}

async function assertKnownPath(
  probing: EnvironmentProbingService,
  userId: string,
  environmentId: string,
  runtime: RuntimeId,
  choice: ToolchainChoice
): Promise<void> {
  if (choice === 'auto') return;

  let status: Awaited<ReturnType<EnvironmentProbingService['getRuntimeStatus']>>;
  try {
    status = await probing.getRuntimeStatus({ userId, environmentId }, runtime);
  } catch (error) {
    // A machine that cannot be asked is unavailable, not an invalid request:
    // the path may well be right, and 422 would send the user to fix a value
    // when the fix is bringing the environment back.
    const detail = error instanceof Error ? error.message : String(error);
    throw new EnvironmentServiceError(
      `Cannot verify ${runtime} installations on "${environmentId}": ${detail}`,
      503
    );
  }
  const known = status?.installations.map((installation) => installation.path) ?? [];
  if (known.includes(choice)) return;

  const expected = known.length > 0 ? known.join(', ') : '(none probed)';
  throw new EnvironmentServiceError(
    `Invalid ${runtime} toolchain path: expected one of: ${expected} | received: ${choice}`,
    422
  );
}

export function createToolchainService(
  repository: EnvironmentToolchainRepository = environmentToolchainRepository,
  probing: EnvironmentProbingService = environmentProbingService,
  now: () => number = Date.now,
  publish: (userId: string) => void = publishEnvironmentInvalidation
): ToolchainService {
  return {
    async resolve(userId, environmentId) {
      const stored = await repository.get(userId, environmentId);
      return stored ?? DEFAULT_TOOLCHAIN_SELECTION;
    },

    async update(userId, environmentId, body) {
      // Keyed off the selection's own runtimes, so a third pinnable one is
      // validated here the moment the schema names it.
      for (const runtimeId of TOOLCHAIN_RUNTIME_IDS) {
        const choice = body[runtimeId];
        if (choice !== undefined) {
          await assertKnownPath(probing, userId, environmentId, runtimeId, choice);
        }
      }

      // The body is already the patch: the repository merges it into the
      // stored row in one statement and answers with what it committed. Doing
      // that here instead — read, merge, write the whole selection — would let
      // a concurrent update of the other runtime revert this one, since the
      // Node and Bun cards autosave through independent mutations.
      const selection = await repository.upsert(userId, environmentId, body, now());
      // The selection is a field of `Environment`, so every other session
      // holding the environments list is now showing a stale pin. Same signal
      // `environment-service` publishes for any other change to that shape.
      publish(userId);
      return selection;
    },
  };
}

export const toolchainService = createToolchainService();
