import type {
  AgentCliStatus,
  RuntimeId,
  RuntimeStatus,
  VersionManagerId,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import {
  AgentCliStatusListSchema,
  AgentCliStatusSchema,
  RuntimeIdSchema,
  RuntimeStatusListSchema,
  RuntimeStatusSchema,
  VersionManagerIdSchema,
  VersionManagerStatusListSchema,
  VersionManagerStatusSchema,
  WslDetectionSchema,
} from '@mangostudio/shared/environments';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import type { LibraryTargetId } from '@mangostudio/shared/library';
import { LibraryTargetIdSchema } from '@mangostudio/shared/library';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  type AgentCliDetectionService,
  agentCliDetectionService,
} from '../application/agent-cli-detection';
import { type EnvironmentService, environmentService } from '../application/environment-service';
import { type InstallService, installService } from '../application/install-service';
import {
  type RuntimeDetectionService,
  runtimeDetectionService,
} from '../application/runtime-detection';
import {
  type VersionManagerDetectionService,
  versionManagerDetectionService,
} from '../application/version-manager-detection';
import {
  markConfiguredDistributions,
  type WslDetectionService,
  wslDetectionService,
} from '../application/wsl-detection';
import { environmentConfigFor, isEnvironmentConfigValid } from '../domain/environment-config';
import { createEnvironmentEntityRoutes } from './environment-entity-routes';
import { createInstallRoutes } from './install-routes';

const runtimeIdParams = t.Object({ id: RuntimeIdSchema });
const versionManagerIdParams = t.Object({ id: VersionManagerIdSchema });
const agentTargetParams = t.Object({ targetId: LibraryTargetIdSchema });

async function getRuntimeOrNotFound(
  service: RuntimeDetectionService,
  id: RuntimeId,
  force: boolean,
  set: { status?: number | string }
): Promise<RuntimeStatus | ApiErrorResponse> {
  const status = await service.getRuntimeStatus(id, { force });
  if (status) return status;

  set.status = 404;
  return {
    error: `Runtime detection is not available for ${id}.`,
    code: ERROR_CODES.NOT_FOUND,
  };
}

async function getVersionManagerOrNotFound(
  service: VersionManagerDetectionService,
  id: VersionManagerId,
  force: boolean,
  set: { status?: number | string }
): Promise<VersionManagerStatus | ApiErrorResponse> {
  const status = await service.getVersionManagerStatus(id, { force });
  if (status) return status;

  set.status = 404;
  return {
    error: `Version manager detection is not available for ${id}.`,
    code: ERROR_CODES.NOT_FOUND,
  };
}

async function getAgentCliOrNotFound(
  service: AgentCliDetectionService,
  targetId: LibraryTargetId,
  force: boolean,
  set: { status?: number | string }
): Promise<AgentCliStatus | ApiErrorResponse> {
  const status = await service.getAgentCliStatus(targetId, { force });
  if (status) return status;

  set.status = 404;
  return {
    error: `Agent CLI detection is not available for ${targetId}.`,
    code: ERROR_CODES.NOT_FOUND,
  };
}

export function createEnvironmentRoutes(
  runtimeService: RuntimeDetectionService = runtimeDetectionService,
  versionManagerService: VersionManagerDetectionService = versionManagerDetectionService,
  agentService: AgentCliDetectionService = agentCliDetectionService,
  environmentInstallService: InstallService = installService,
  entityService: EnvironmentService = environmentService,
  wslService: WslDetectionService = wslDetectionService
) {
  return new Elysia()
    .use(requireAuth)
    .get('/environments/runtimes', () => runtimeService.listRuntimeStatuses(), {
      response: { 200: RuntimeStatusListSchema },
    })
    .get(
      '/environments/runtimes/:id',
      ({ params, set }) => getRuntimeOrNotFound(runtimeService, params.id, false, set),
      {
        params: runtimeIdParams,
        response: {
          200: RuntimeStatusSchema,
          404: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/environments/runtimes/:id/probe',
      ({ params, set }) => getRuntimeOrNotFound(runtimeService, params.id, true, set),
      {
        params: runtimeIdParams,
        response: {
          200: RuntimeStatusSchema,
          404: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/environments/version-managers',
      () => versionManagerService.listVersionManagerStatuses(),
      {
        response: { 200: VersionManagerStatusListSchema },
      }
    )
    .get(
      '/environments/version-managers/:id',
      ({ params, set }) =>
        getVersionManagerOrNotFound(versionManagerService, params.id, false, set),
      {
        params: versionManagerIdParams,
        response: {
          200: VersionManagerStatusSchema,
          404: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/environments/version-managers/:id/probe',
      ({ params, set }) => getVersionManagerOrNotFound(versionManagerService, params.id, true, set),
      {
        params: versionManagerIdParams,
        response: {
          200: VersionManagerStatusSchema,
          404: ApiErrorResponseSchema,
        },
      }
    )
    .get('/environments/agents', () => agentService.listAgentCliStatuses(), {
      response: { 200: AgentCliStatusListSchema },
    })
    .get(
      '/environments/agents/:targetId',
      ({ params, set }) => getAgentCliOrNotFound(agentService, params.targetId, false, set),
      {
        params: agentTargetParams,
        response: {
          200: AgentCliStatusSchema,
          404: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/environments/agents/:targetId/probe',
      ({ params, set }) => getAgentCliOrNotFound(agentService, params.targetId, true, set),
      {
        params: agentTargetParams,
        response: {
          200: AgentCliStatusSchema,
          404: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/environments/wsl',
      async ({ user }) => {
        const detection = await wslService.detect();
        if (detection.distributions.length === 0) return detection;
        return {
          ...detection,
          distributions: markConfiguredDistributions(
            detection.distributions,
            await configuredWslDistros(entityService, user?.id ?? '')
          ),
        };
      },
      { response: { 200: WslDetectionSchema } }
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
