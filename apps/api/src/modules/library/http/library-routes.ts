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
  type LibraryTargetId,
  LibraryTargetIdSchema,
  parseResourceKey,
  type ResourceKind,
  ResourceKindSchema,
} from '@mangostudio/shared/library';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { readRegularFileUtf8 } from '../../../lib/safe-file';
import { requireAuth } from '../../../plugins/auth-middleware';
import { discoverLibraryResources } from '../application/library-discovery';
import { LIBRARY_LOCATION_DEFINITIONS } from '../domain/registry';
import { createLibraryPathEnv, describeLocation } from '../infrastructure/location-probe';

export const MAX_LIBRARY_CONTENT_BYTES = 512 * 1024;

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

function readResourceContent(
  resource: LibraryResource,
  locationId: LibraryLocationId
): LibraryResourceContent | null {
  const instance = resource.instances.find((candidate) => candidate.locationId === locationId);
  if (!instance) return null;

  const contentPath = resource.ref.kind === 'skill' ? `${instance.path}/SKILL.md` : instance.path;
  const result = readRegularFileUtf8(contentPath, {
    maxBytes: MAX_LIBRARY_CONTENT_BYTES,
    truncateOversize: true,
  });
  return {
    key: resource.key,
    locationId,
    content: result.content,
    truncated: result.truncated,
    sizeBytes: result.sizeBytes,
  };
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
  console.error('[library] Unexpected error:', error);
  set.status = 500;
  return {
    error: 'Unexpected library discovery error.',
    code: ERROR_CODES.INTERNAL,
  };
}

const resourceQuery = t.Object({
  kind: t.Optional(ResourceKindSchema),
  target: t.Optional(LibraryTargetIdSchema),
  location: t.Optional(LibraryLocationIdSchema),
  state: t.Optional(LibraryCoverageStateSchema),
});
const resourceParams = t.Object({ key: t.String() });

export interface LibraryRouteService {
  discover(userId: string, force: boolean): Promise<LibraryResource[]>;
  listLocations(): LibraryLocationStatus[];
  readContent(
    resource: LibraryResource,
    locationId: LibraryLocationId
  ): LibraryResourceContent | null;
}

const defaultLibraryRouteService: LibraryRouteService = {
  discover: (userId, force) => discoverLibraryResources(getDb(), userId, { force }),
  listLocations() {
    const env = createLibraryPathEnv();
    return LIBRARY_LOCATION_DEFINITIONS.map((location) => describeLocation(location.id, env));
  },
  readContent: readResourceContent,
};

export function createLibraryRoutes(service: LibraryRouteService = defaultLibraryRouteService) {
  return new Elysia()
    .use(requireAuth)
    .get(
      '/library/resources',
      async ({ query, set, user }): Promise<LibraryResource[] | ApiErrorResponse> => {
        try {
          const resources = await service.discover(user?.id ?? '', false);
          return filterLibraryResources(resources, query);
        } catch (error) {
          return handleLibraryError(error, set);
        }
      },
      {
        query: resourceQuery,
        response: {
          200: LibraryResourceListSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/library/resources/:key/content',
      async ({ params, query, set, user }): Promise<LibraryResourceContent | ApiErrorResponse> => {
        if (!parseResourceKey(params.key)) return invalidResourceKey(set);
        try {
          const resources = await service.discover(user?.id ?? '', false);
          const resource = resources.find((candidate) => candidate.key === params.key);
          if (!resource) return resourceNotFound(set);
          return service.readContent(resource, query.location) ?? resourceNotFound(set);
        } catch (error) {
          return handleLibraryError(error, set);
        }
      },
      {
        params: resourceParams,
        query: t.Object({ location: LibraryLocationIdSchema }),
        response: {
          200: LibraryResourceContentSchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/library/resources/:key',
      async ({ params, set, user }): Promise<LibraryResource | ApiErrorResponse> => {
        if (!parseResourceKey(params.key)) return invalidResourceKey(set);
        try {
          const resources = await service.discover(user?.id ?? '', false);
          return (
            resources.find((candidate) => candidate.key === params.key) ?? resourceNotFound(set)
          );
        } catch (error) {
          return handleLibraryError(error, set);
        }
      },
      {
        params: resourceParams,
        response: {
          200: LibraryResourceSchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get('/library/locations', () => service.listLocations(), {
      response: { 200: LibraryLocationStatusListSchema },
    })
    .post(
      '/library/rescan',
      async ({ query, set, user }): Promise<LibraryResource[] | ApiErrorResponse> => {
        try {
          return await service.discover(user?.id ?? '', query.force === 'true');
        } catch (error) {
          return handleLibraryError(error, set);
        }
      },
      {
        query: t.Object({
          force: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
        }),
        response: {
          200: LibraryResourceListSchema,
          500: ApiErrorResponseSchema,
        },
      }
    );
}

export const libraryRoutes = createLibraryRoutes();
