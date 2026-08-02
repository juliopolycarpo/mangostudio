import { RuntimeRemoteError } from '@mangostudio/runtime';
import { EnvironmentIdSchema, LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  type LibraryCoverageState,
  LibraryCoverageStateSchema,
  type LibraryLocationId,
  LibraryLocationIdSchema,
  type LibraryLocationStatus,
  LibraryLocationStatusListSchema,
  type LibraryResource,
  type LibraryResourceContent,
  LibraryResourceContentSchema,
  LibraryResourceListSchema,
  LibraryResourceSchema,
  type LibraryTargetDescriptor,
  LibraryTargetDescriptorListSchema,
  type LibraryTargetId,
  LibraryTargetIdSchema,
  parseResourceKey,
  type ResourceKind,
  ResourceKindSchema,
} from '@mangostudio/shared/library';
import { listLibraryTargetDescriptors } from '@mangostudio/shared/library/host';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  validateWorkdir,
  type WorkdirValidationResult,
} from '../../workspaces/application/workdir-validation';
import { WorkspacePathError } from '../../workspaces/application/workspace-path';
import {
  environmentLibraryService,
  LibraryFeatureUnavailableError,
  type LibraryScope,
} from '../application/environment-library-service';

export { MAX_LIBRARY_CONTENT_BYTES } from '@mangostudio/runtime';

interface ResourceFilters {
  readonly kind?: ResourceKind;
  readonly target?: LibraryTargetId;
  readonly location?: LibraryLocationId;
  readonly state?: LibraryCoverageState;
}

function filterLibraryResources(
  resources: readonly LibraryResource[],
  filters: ResourceFilters
): LibraryResource[] {
  return resources.filter((resource) => {
    if (filters.kind && resource.ref.kind !== filters.kind) return false;
    if (
      filters.location &&
      !resource.instances.some((instance) => instance.locationId === filters.location)
    ) {
      return false;
    }

    if (filters.target) {
      const coverage = resource.coverage.find((candidate) => candidate.targetId === filters.target);
      if (!coverage) return false;
      return filters.state ? coverage.state === filters.state : coverage.state !== 'absent';
    }

    if (filters.state && !resource.coverage.some((coverage) => coverage.state === filters.state)) {
      return false;
    }
    return true;
  });
}

function invalidResourceKey(set: { status?: number | string }): ApiErrorResponse {
  set.status = 400;
  return {
    error: 'Invalid library resource key.',
    code: ERROR_CODES.VALIDATION,
  };
}

function resourceNotFound(set: { status?: number | string }): ApiErrorResponse {
  set.status = 404;
  return {
    error: 'Library resource not found.',
    code: ERROR_CODES.NOT_FOUND,
  };
}

function handleLibraryError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof LibraryFeatureUnavailableError) {
    set.status = 422;
    return {
      error: error.message,
      code: ERROR_CODES.VALIDATION,
    };
  }
  // A disabled, unknown, or unreachable environment is a routine state once
  // discovery is per-environment, not a hub fault: it gets the same 503 the
  // environment routes give, and no error log.
  if (error instanceof RuntimeRemoteError && error.code === 'RUNTIME_UNAVAILABLE') {
    set.status = 503;
    return {
      error: error.message,
      code: ERROR_CODES.PROVIDER_ERROR,
    };
  }
  console.error('[library] Unexpected error:', error);
  set.status = 500;
  return {
    error: 'Unexpected library discovery error.',
    code: ERROR_CODES.INTERNAL,
  };
}

/**
 * Root a `workspace`-scoped location would resolve under.
 *
 * Reserved and inert: v1 defines no workspace location, so every response is
 * byte-identical with and without it. It is validated anyway, and rejected with
 * 422 when it does not name a readable directory — a parameter that silently
 * does nothing when malformed is worse than one that does nothing at all, and
 * the day locations do resolve under it, a typo would quietly return the
 * home-only matrix instead of an error.
 *
 * Named for a path rather than an id because that is what a workspace is here:
 * `workspaceSettings` and chat workdirs both store roots, and no workspace
 * entity or id space exists to validate against.
 */
const WorkspaceRootSchema = t.Optional(t.String({ minLength: 1, maxLength: 4096 }));
const EnvironmentIdQuerySchema = t.Optional(EnvironmentIdSchema);

const resourceQuery = t.Object({
  kind: t.Optional(ResourceKindSchema),
  target: t.Optional(LibraryTargetIdSchema),
  location: t.Optional(LibraryLocationIdSchema),
  state: t.Optional(LibraryCoverageStateSchema),
  workspaceRoot: WorkspaceRootSchema,
  environmentId: EnvironmentIdQuerySchema,
});
const resourceParams = t.Object({ key: t.String() });

function rejectWorkspaceRoot(
  set: { status?: number | string },
  message: string
): { ok: false; body: ApiErrorResponse } {
  set.status = 422;
  return { ok: false, body: { error: message, code: ERROR_CODES.VALIDATION } };
}

/** Resolves the requested root, or the 422 body explaining why it cannot. */
async function resolveWorkspaceRoot(
  workspaceRoot: string | undefined,
  set: { status?: number | string }
): Promise<{ ok: true; root: string | undefined } | { ok: false; body: ApiErrorResponse }> {
  if (workspaceRoot === undefined) return { ok: true, root: undefined };

  let validation: WorkdirValidationResult;
  try {
    // Absolute only. A relative root would resolve against the server process's
    // working directory, which is a tree the caller never named.
    validation = await validateWorkdir(workspaceRoot, { requireAbsolute: true });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return rejectWorkspaceRoot(set, error.message);
    }
    throw error;
  }

  return validation.ok
    ? { ok: true, root: validation.resolvedPath }
    : rejectWorkspaceRoot(set, `The workspace root is ${validation.reason}.`);
}

function scopeFor(userId: string, environmentId: string | undefined): LibraryScope {
  return {
    userId,
    environmentId: environmentId ?? LOCAL_ENVIRONMENT_ID,
  };
}

export interface LibraryRouteService {
  discover(
    userId: string,
    force: boolean,
    workspaceRoot?: string,
    environmentId?: string
  ): Promise<LibraryResource[]>;
  listLocations(
    userId: string,
    workspaceRoot?: string,
    environmentId?: string
  ): Promise<LibraryLocationStatus[]>;
  listTargets(): LibraryTargetDescriptor[];
  readContent(
    userId: string,
    resource: LibraryResource,
    locationId: LibraryLocationId,
    workspaceRoot?: string,
    environmentId?: string
  ): Promise<LibraryResourceContent | null>;
}

const defaultLibraryRouteService: LibraryRouteService = {
  discover: (userId, force, workspaceRoot, environmentId) =>
    environmentLibraryService.discover(getDb(), scopeFor(userId, environmentId), {
      force,
      workspaceRoot,
    }),
  listLocations: (userId, workspaceRoot, environmentId) =>
    environmentLibraryService.listLocations(
      getDb(),
      scopeFor(userId, environmentId),
      workspaceRoot
    ),
  listTargets: listLibraryTargetDescriptors,
  readContent: (userId, resource, locationId, workspaceRoot, environmentId) =>
    environmentLibraryService.readContent(
      getDb(),
      scopeFor(userId, environmentId),
      resource,
      locationId,
      workspaceRoot
    ),
};

export function createLibraryRoutes(service: LibraryRouteService = defaultLibraryRouteService) {
  return (
    new Elysia()
      .use(requireAuth)
      .get(
        '/library/resources',
        async ({ query, set, user }): Promise<LibraryResource[] | ApiErrorResponse> => {
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot, set);
          if (!workspace.ok) return workspace.body;
          try {
            const resources = await service.discover(
              user?.id ?? '',
              false,
              workspace.root,
              query.environmentId
            );
            return filterLibraryResources(resources, query);
          } catch (error) {
            return handleLibraryError(error, set);
          }
        },
        {
          query: resourceQuery,
          response: {
            200: LibraryResourceListSchema,
            422: ApiErrorResponseSchema,
            500: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
        }
      )
      .get(
        '/library/resources/:key/content',
        async ({
          params,
          query,
          set,
          user,
        }): Promise<LibraryResourceContent | ApiErrorResponse> => {
          if (!parseResourceKey(params.key)) return invalidResourceKey(set);
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot, set);
          if (!workspace.ok) return workspace.body;
          try {
            const resources = await service.discover(
              user?.id ?? '',
              false,
              workspace.root,
              query.environmentId
            );
            const resource = resources.find((candidate) => candidate.key === params.key);
            if (!resource) return resourceNotFound(set);
            return (
              (await service.readContent(
                user?.id ?? '',
                resource,
                query.location,
                workspace.root,
                query.environmentId
              )) ?? resourceNotFound(set)
            );
          } catch (error) {
            return handleLibraryError(error, set);
          }
        },
        {
          params: resourceParams,
          query: t.Object({
            location: LibraryLocationIdSchema,
            workspaceRoot: WorkspaceRootSchema,
            environmentId: EnvironmentIdQuerySchema,
          }),
          response: {
            200: LibraryResourceContentSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            422: ApiErrorResponseSchema,
            500: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
        }
      )
      .get(
        '/library/resources/:key',
        async ({ params, query, set, user }): Promise<LibraryResource | ApiErrorResponse> => {
          if (!parseResourceKey(params.key)) return invalidResourceKey(set);
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot, set);
          if (!workspace.ok) return workspace.body;
          try {
            const resources = await service.discover(
              user?.id ?? '',
              false,
              workspace.root,
              query.environmentId
            );
            return (
              resources.find((candidate) => candidate.key === params.key) ?? resourceNotFound(set)
            );
          } catch (error) {
            return handleLibraryError(error, set);
          }
        },
        {
          params: resourceParams,
          query: t.Object({
            workspaceRoot: WorkspaceRootSchema,
            environmentId: EnvironmentIdQuerySchema,
          }),
          response: {
            200: LibraryResourceSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            422: ApiErrorResponseSchema,
            500: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
        }
      )
      .get(
        '/library/locations',
        async ({ query, set, user }): Promise<LibraryLocationStatus[] | ApiErrorResponse> => {
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot, set);
          if (!workspace.ok) return workspace.body;
          try {
            return await service.listLocations(user?.id ?? '', workspace.root, query.environmentId);
          } catch (error) {
            return handleLibraryError(error, set);
          }
        },
        {
          query: t.Object({
            workspaceRoot: WorkspaceRootSchema,
            environmentId: EnvironmentIdQuerySchema,
          }),
          response: {
            200: LibraryLocationStatusListSchema,
            422: ApiErrorResponseSchema,
            500: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
        }
      )
      // The coverage matrix has one column per target, and that column set has to
      // be stable even when a filter leaves no rows to infer it from.
      .get('/library/targets', () => service.listTargets(), {
        response: { 200: LibraryTargetDescriptorListSchema },
      })
      .post(
        '/library/rescan',
        async ({ query, set, user }): Promise<LibraryResource[] | ApiErrorResponse> => {
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot, set);
          if (!workspace.ok) return workspace.body;
          try {
            return await service.discover(
              user?.id ?? '',
              query.force === 'true',
              workspace.root,
              query.environmentId
            );
          } catch (error) {
            return handleLibraryError(error, set);
          }
        },
        {
          query: t.Object({
            force: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
            workspaceRoot: WorkspaceRootSchema,
            environmentId: EnvironmentIdQuerySchema,
          }),
          response: {
            200: LibraryResourceListSchema,
            422: ApiErrorResponseSchema,
            500: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
        }
      )
  );
}

export const libraryRoutes = createLibraryRoutes();
