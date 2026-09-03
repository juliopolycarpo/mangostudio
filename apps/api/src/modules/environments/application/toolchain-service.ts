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
import { DEFAULT_TOOLCHAIN_SELECTION } from '@mangostudio/shared/environments';
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
  now: () => number = Date.now
): ToolchainService {
  return {
    async resolve(userId, environmentId) {
      const stored = await repository.get(userId, environmentId);
      return stored ?? DEFAULT_TOOLCHAIN_SELECTION;
    },

    async update(userId, environmentId, body) {
      const current = (await repository.get(userId, environmentId)) ?? DEFAULT_TOOLCHAIN_SELECTION;
      const merged: ToolchainSelection = {
        node: body.node ?? current.node,
        bun: body.bun ?? current.bun,
      };

      if (body.node !== undefined) {
        await assertKnownPath(probing, userId, environmentId, 'node', body.node);
      }
      if (body.bun !== undefined) {
        await assertKnownPath(probing, userId, environmentId, 'bun', body.bun);
      }

      await repository.upsert(userId, environmentId, merged, now());
      return merged;
    },
  };
}

export const toolchainService = createToolchainService();
