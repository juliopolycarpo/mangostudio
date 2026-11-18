import type { RuntimeId, VersionManagerId } from '@mangostudio/shared/environments';
import {
  AgentCliStatusListSchema,
  AgentCliStatusSchema,
  ContainerDetectionSchema,
  EnvironmentIdSchema,
  LOCAL_ENVIRONMENT_ID,
  RuntimeIdSchema,
  RuntimeStatusListSchema,
  RuntimeStatusSchema,
  VersionManagerIdSchema,
  VersionManagerStatusListSchema,
  VersionManagerStatusSchema,
  WslDetectionSchema,
} from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import type { LibraryTargetId } from '@mangostudio/shared/library';
import { LibraryTargetIdSchema } from '@mangostudio/shared/library';
import { Elysia, status, t } from 'elysia';

import { requireAuth } from '../../../plugins/auth-middleware';
import { type EnvironmentService, environmentService } from '../application/environment-service';
import { type InstallService, installService } from '../application/install-service';
import {
  type EnvironmentProbingService,
  environmentProbingService,
  type ProbeScope,
} from '../application/probing-service';
import {
  markConfiguredDistributions,
  type WslDetectionService,
  wslDetectionService,
} from '../application/wsl-detection';
import { environmentConfigFor, isEnvironmentConfigValid } from '../domain/environment-config';
import {
  type ContainerEngineService,
  containerEngineService,
} from '../infrastructure/container-engine';
import { createEnvironmentEntityRoutes } from './environment-entity-routes';
import { createInstallRoutes } from './install-routes';

const runtimeIdParams = t.Object({ id: RuntimeIdSchema });
const versionManagerIdParams = t.Object({ id: VersionManagerIdSchema });
const agentTargetParams = t.Object({ targetId: LibraryTargetIdSchema });

/**
 * Which machine the question is about. Omitted means the hub's own, so every
 * existing caller keeps its answer; anything else names an environment the
 * signed-in user owns, and an unreachable one fails as a runtime problem rather
 * than being answered with the hub's toolchains under someone else's name.
 */
const environmentQuery = t.Object({
  environmentId: t.Optional(EnvironmentIdSchema),
});

function scopeFor(
  user: { id: string } | null | undefined,
  query: { environmentId?: string }
): ProbeScope {
  return {
    userId: user?.id ?? '',
    environmentId: query.environmentId ?? LOCAL_ENVIRONMENT_ID,
  };
}

async function getRuntimeOrNotFound(
  service: EnvironmentProbingService,
  scope: ProbeScope,
  id: RuntimeId,
  force: boolean
) {
  const detected = await service.getRuntimeStatus(scope, id, { force });
  if (detected) return detected;

  return status(404, {
    error: `Runtime detection is not available for ${id}.`,
    code: ERROR_CODES.NOT_FOUND,
  });
}

async function getVersionManagerOrNotFound(
  service: EnvironmentProbingService,
  scope: ProbeScope,
  id: VersionManagerId,
  force: boolean
) {
  const detected = await service.getVersionManagerStatus(scope, id, { force });
  if (detected) return detected;

  return status(404, {
    error: `Version manager detection is not available for ${id}.`,
    code: ERROR_CODES.NOT_FOUND,
  });
}

async function getAgentCliOrNotFound(
  service: EnvironmentProbingService,
  scope: ProbeScope,
  targetId: LibraryTargetId,
  force: boolean
) {
  const detected = await service.getAgentCliStatus(scope, targetId, { force });
  if (detected) return detected;

  return status(404, {
    error: `Agent CLI detection is not available for ${targetId}.`,
    code: ERROR_CODES.NOT_FOUND,
  });
}

export function createEnvironmentRoutes(
  probingService: EnvironmentProbingService = environmentProbingService,
  environmentInstallService: InstallService = installService,
  entityService: EnvironmentService = environmentService,
  wslService: WslDetectionService = wslDetectionService,
  containerService: ContainerEngineService = containerEngineService
) {
  return new Elysia()
    .use(requireAuth)
    .get(
      '/environments/runtimes',
      { query: environmentQuery, response: { 200: RuntimeStatusListSchema } },
      ({ user, query }) => probingService.listRuntimeStatuses(scopeFor(user, query))
    )
    .get(
      '/environments/runtimes/:id',
      {
        params: runtimeIdParams,
        query: environmentQuery,
        response: {
          200: RuntimeStatusSchema,
          404: ApiErrorResponseSchema,
        },
      },
      ({ params, query, user }) =>
        getRuntimeOrNotFound(probingService, scopeFor(user, query), params.id, false)
    )
    .post(
      '/environments/runtimes/:id/probe',
      {
        params: runtimeIdParams,
        query: environmentQuery,
        response: {
          200: RuntimeStatusSchema,
          404: ApiErrorResponseSchema,
        },
      },
      ({ params, query, user }) =>
        getRuntimeOrNotFound(probingService, scopeFor(user, query), params.id, true)
    )
    .get(
      '/environments/version-managers',
      { query: environmentQuery, response: { 200: VersionManagerStatusListSchema } },
      ({ user, query }) => probingService.listVersionManagerStatuses(scopeFor(user, query))
    )
    .get(
      '/environments/version-managers/:id',
      {
        params: versionManagerIdParams,
        query: environmentQuery,
        response: {
          200: VersionManagerStatusSchema,
          404: ApiErrorResponseSchema,
        },
      },
      ({ params, query, user }) =>
        getVersionManagerOrNotFound(probingService, scopeFor(user, query), params.id, false)
    )
    .post(
      '/environments/version-managers/:id/probe',
      {
        params: versionManagerIdParams,
        query: environmentQuery,
        response: {
          200: VersionManagerStatusSchema,
          404: ApiErrorResponseSchema,
        },
      },
      ({ params, query, user }) =>
        getVersionManagerOrNotFound(probingService, scopeFor(user, query), params.id, true)
    )
    .get(
      '/environments/agents',
      { query: environmentQuery, response: { 200: AgentCliStatusListSchema } },
      ({ user, query }) => probingService.listAgentCliStatuses(scopeFor(user, query))
    )
    .get(
      '/environments/agents/:targetId',
      {
        params: agentTargetParams,
        query: environmentQuery,
        response: {
          200: AgentCliStatusSchema,
          404: ApiErrorResponseSchema,
        },
      },
      ({ params, query, user }) =>
        getAgentCliOrNotFound(probingService, scopeFor(user, query), params.targetId, false)
    )
    .post(
      '/environments/agents/:targetId/probe',
      {
        params: agentTargetParams,
        query: environmentQuery,
        response: {
          200: AgentCliStatusSchema,
          404: ApiErrorResponseSchema,
        },
      },
      ({ params, query, user }) =>
        getAgentCliOrNotFound(probingService, scopeFor(user, query), params.targetId, true)
    )
    .get('/environments/wsl', { response: { 200: WslDetectionSchema } }, async ({ user }) => {
      const detection = await wslService.detect();
      if (detection.distributions.length === 0) return detection;
      return {
        ...detection,
        distributions: markConfiguredDistributions(
          detection.distributions,
          await configuredWslDistros(entityService, user?.id ?? '')
        ),
      };
    })
    .get(
      '/environments/containers',
      {
        response: { 200: ContainerDetectionSchema },
      },
      () => containerService.detect()
    )
    .use(createInstallRoutes(environmentInstallService))
    .use(createEnvironmentEntityRoutes(entityService));
}

/** Distribution name → environment id, for the distros already configured. */
async function configuredWslDistros(
  service: EnvironmentService,
  userId: string
): Promise<Map<string, string>> {
  const environments = await service.list(userId);
  const configured = new Map<string, string>();
  for (const environment of environments) {
    if (environment.transportKind !== 'wsl') continue;
    if (!isEnvironmentConfigValid('wsl', environment.config)) continue;
    configured.set(environmentConfigFor('wsl', environment.config).distro, environment.id);
  }
  return configured;
}

export const environmentRoutes = createEnvironmentRoutes();
