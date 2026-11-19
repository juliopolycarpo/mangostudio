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
  LibraryResourceSchema,
  type LibraryScanResult,
  LibraryScanResultSchema,
  type LibraryTargetDescriptor,
  LibraryTargetDescriptorListSchema,
  type LibraryTargetId,
  LibraryTargetIdSchema,
  type LibraryUnreadableEntry,
  parseResourceKey,
  type ResourceKind,
  ResourceKindSchema,
} from '@mangostudio/shared/library';
import {
  LIBRARY_LOCATION_DEFINITIONS,
  listLibraryTargetDescriptors,
} from '@mangostudio/shared/library/host';
import { WorkspacePathError } from '@mangostudio/shared/runtime-contract';
import { Elysia, type ElysiaStatus, status, t } from 'elysia';
import type { Static } from 'typebox';

import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  validateWorkdir,
  type WorkdirValidationResult,
} from '../../workspaces/application/workdir-validation';
import {
  type EnvironmentLibraryService,
  environmentLibraryService,
  type LibraryScope,
} from '../application/environment-library-service';
import { handleLibraryError } from './library-error';

export { MAX_LIBRARY_CONTENT_BYTES } from '@mangostudio/shared/library/machine';

/** Narrowing that applies to anything a scan found, resource or not. */
interface ScanFilters {
  readonly kind?: ResourceKind;
  readonly location?: LibraryLocationId;
}

/**
 * A filter set that is already self-consistent: `state` only ever appears next
 * to the `target` whose coverage it describes.
 *
 * The union is the guard. `state` alone used to mean "some target has this
 * state", which matches nearly the whole library — most targets read none of a
 * given location, so almost every resource is `absent` for at least one of them,
 * and `shadowed` answered "shadowed somewhere", a question the matrix never
 * asks. No value of this type can express that reading, so no filtering pass can
 * quietly bring it back.
 */
type ResourceFilters = ScanFilters &
  (
    | { readonly target?: undefined; readonly state?: undefined }
    | { readonly target: LibraryTargetId; readonly state?: LibraryCoverageState }
  );

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
      const incomplete = Boolean(coverage.unscannedLocationIds?.length);
      // Once the resolver finds an effective copy and a shadow, a lower
      // unscanned location cannot undo either observation.
      return filters.state
        ? coverage.state === filters.state && (filters.state === 'shadowed' || !incomplete)
        : incomplete || coverage.state !== 'absent';
    }
    return true;
  });
}

const LOCATION_KIND_BY_ID = new Map(
  LIBRARY_LOCATION_DEFINITIONS.map((location) => [location.id, location.kind])
);

/**
 * A scan without `kinds` covers every kind, and `location` is never forwarded,
 * so this channel needs the same `kind`/`location` narrowing the resource list
 * gets — and nothing more. It
 * takes {@link ScanFilters} rather than {@link ResourceFilters} so the coverage
 * filters are not merely ignored here but unavailable.
 */
function filterUnreadableEntries(
  entries: readonly LibraryUnreadableEntry[],
  filters: ScanFilters
): LibraryUnreadableEntry[] {
  return entries.filter((entry) => {
    if (filters.kind && LOCATION_KIND_BY_ID.get(entry.locationId) !== filters.kind) return false;
    if (filters.location && entry.locationId !== filters.location) return false;
    return true;
  });
}

function filterLibraryScanResult(
  scan: LibraryScanResult,
  filters: ResourceFilters
): LibraryScanResult {
  return {
    resources: filterLibraryResources(scan.resources, filters),
    unreadableEntries: filterUnreadableEntries(scan.unreadableEntries, filters),
    ...(scan.locationDiagnostics !== undefined && {
      locationDiagnostics: scan.locationDiagnostics.filter(
        (entry) =>
          (!filters.kind || LOCATION_KIND_BY_ID.get(entry.locationId) === filters.kind) &&
          (!filters.location || entry.locationId === filters.location)
      ),
    }),
  };
}

function invalidResourceKey() {
  return status(400, {
    error: 'Invalid library resource key.',
    code: ERROR_CODES.VALIDATION,
  });
}

function missingResourceResponse(
  scan: LibraryScanResult,
  kind: ResourceKind,
  location?: LibraryLocationId
) {
  if (
    scan.locationDiagnostics?.some(
      ({ locationId }) =>
        LOCATION_KIND_BY_ID.get(locationId) === kind && (!location || locationId === location)
    )
  ) {
    return status(503, {
      error: 'The library scan could not verify whether this resource is available.',
      code: ERROR_CODES.PROVIDER_ERROR,
    });
  }
  return status(404, {
    error: 'Library resource not found.',
    code: ERROR_CODES.NOT_FOUND,
  });
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

/**
 * Filters over one scan.
 *
 * `kind` and `location` narrow both lists in the response. `target` and `state`
 * describe a resource's coverage, so they narrow `resources` alone and leave
 * `unreadableEntries` untouched: an entry that could not even be named as a
 * resource has no coverage to have a state in, and silently dropping it from a
 * target-filtered view would hide the very names the channel exists to report.
 *
 * `state` requires `target`. The dependency is checked in the handler rather
 * than declared in the schema because TypeBox carries no cross-property
 * requirement Elysia would enforce, and a schema rejection would surface as a
 * bare 422 instead of the 400 that names the fix.
 */
const resourceQuery = t.Object({
  kind: t.Optional(ResourceKindSchema),
  target: t.Optional(LibraryTargetIdSchema),
  location: t.Optional(LibraryLocationIdSchema),
  state: t.Optional(LibraryCoverageStateSchema),
  workspaceRoot: WorkspaceRootSchema,
  environmentId: EnvironmentIdQuerySchema,
});
const resourceParams = t.Object({ key: t.String() });

/** Names the fix, not just the rule — the caller has to know what to add. */
export const STATE_REQUIRES_TARGET_MESSAGE =
  "`state` filters a target's coverage, so it requires `target`.";

/**
 * Resolves the coverage filters, or the 400 answer explaining why they contradict
 * each other. Returns the narrowed {@link ResourceFilters} so the filter pass
 * receives a combination that has already been proven answerable.
 */
function parseResourceFilters(
  query: Pick<Static<typeof resourceQuery>, 'kind' | 'target' | 'location' | 'state'>
):
  | { ok: true; filters: ResourceFilters }
  | { ok: false; failure: ElysiaStatus<400, ApiErrorResponse> } {
  if (query.state && !query.target) {
    return {
      ok: false,
      failure: status(400, { error: STATE_REQUIRES_TARGET_MESSAGE, code: ERROR_CODES.VALIDATION }),
    };
  }

  const scope: ScanFilters = { kind: query.kind, location: query.location };
  return {
    ok: true,
    filters: query.target ? { ...scope, target: query.target, state: query.state } : scope,
  };
}

type WorkspaceRootRejection = {
  ok: false;
  failure: ElysiaStatus<422, ApiErrorResponse>;
};

function rejectWorkspaceRoot(message: string): WorkspaceRootRejection {
  return { ok: false, failure: status(422, { error: message, code: ERROR_CODES.VALIDATION }) };
}

/** Resolves the requested root, or the 422 answer explaining why it cannot. */
async function resolveWorkspaceRoot(
  workspaceRoot: string | undefined
): Promise<{ ok: true; root: string | undefined } | WorkspaceRootRejection> {
  if (workspaceRoot === undefined) return { ok: true, root: undefined };

  let validation: WorkdirValidationResult;
  try {
    // Absolute only. A relative root would resolve against the server process's
    // working directory, which is a tree the caller never named.
    validation = await validateWorkdir(workspaceRoot, { requireAbsolute: true });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return rejectWorkspaceRoot(error.message);
    }
    throw error;
  }

  return validation.ok
    ? { ok: true, root: validation.resolvedPath }
    : rejectWorkspaceRoot(`The workspace root is ${validation.reason}.`);
}

function scopeFor(userId: string, environmentId: string | undefined): LibraryScope {
  return {
    userId,
    environmentId: environmentId ?? LOCAL_ENVIRONMENT_ID,
  };
}

export interface LibraryRouteService {
  /**
   * `kinds` restricts the scan itself, not only the answer: omit it for the full
   * library. A narrowed scan is cached apart from the full one.
   */
  discover(
    userId: string,
    force: boolean,
    workspaceRoot?: string,
    environmentId?: string,
    kinds?: readonly ResourceKind[]
  ): Promise<LibraryScanResult>;
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

/**
 * Binds the routes' service seam to an environment library service. A named
 * factory rather than only the default instance so a test can drive the real
 * glue with a service built over a fake runtime.
 */
export function createLibraryRouteService(
  library: EnvironmentLibraryService = environmentLibraryService
): LibraryRouteService {
  return {
    discover: (userId, force, workspaceRoot, environmentId, kinds) =>
      library.discover(getDb(), scopeFor(userId, environmentId), {
        force,
        workspaceRoot,
        kinds,
      }),
    listLocations: (userId, workspaceRoot, environmentId) =>
      library.listLocations(getDb(), scopeFor(userId, environmentId), workspaceRoot),
    listTargets: listLibraryTargetDescriptors,
    readContent: (userId, resource, locationId, workspaceRoot, environmentId) =>
      library.readContent(
        getDb(),
        scopeFor(userId, environmentId),
        resource,
        locationId,
        workspaceRoot
      ),
  };
}

const defaultLibraryRouteService = createLibraryRouteService();

export function createLibraryRoutes(service: LibraryRouteService = defaultLibraryRouteService) {
  return (
    new Elysia()
      .use(requireAuth)
      .get(
        '/library/resources',
        {
          query: resourceQuery,
          response: {
            200: LibraryScanResultSchema,
            400: ApiErrorResponseSchema,
            422: ApiErrorResponseSchema,
            500: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
        },
        async ({ query, set, user }) => {
          // Before the scan: a filter combination with no answer should not cost
          // a filesystem walk to reject.
          const filters = parseResourceFilters(query);
          if (!filters.ok) return filters.failure;
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot);
          if (!workspace.ok) return workspace.failure;
          try {
            // The kind goes into the scan as well as the filter below: a
            // single-kind answer must not pay for walking the other kinds.
            const scan = await service.discover(
              user?.id ?? '',
              false,
              workspace.root,
              query.environmentId,
              filters.filters.kind ? [filters.filters.kind] : undefined
            );
            return filterLibraryScanResult(scan, filters.filters);
          } catch (error) {
            return handleLibraryError(error, set);
          }
        }
      )
      .get(
        '/library/resources/:key/content',
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
        },
        async ({ params, query, set, user }) => {
          const ref = parseResourceKey(params.key);
          if (!ref) return invalidResourceKey();
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot);
          if (!workspace.ok) return workspace.failure;
          try {
            const scan = await service.discover(
              user?.id ?? '',
              false,
              workspace.root,
              query.environmentId
            );
            const resource = scan.resources.find((candidate) => candidate.key === params.key);
            if (!resource) return missingResourceResponse(scan, ref.kind, query.location);
            return (
              (await service.readContent(
                user?.id ?? '',
                resource,
                query.location,
                workspace.root,
                query.environmentId
              )) ?? missingResourceResponse(scan, ref.kind, query.location)
            );
          } catch (error) {
            return handleLibraryError(error, set);
          }
        }
      )
      .get(
        '/library/resources/:key',
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
        },
        async ({ params, query, set, user }) => {
          const ref = parseResourceKey(params.key);
          if (!ref) return invalidResourceKey();
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot);
          if (!workspace.ok) return workspace.failure;
          try {
            const scan = await service.discover(
              user?.id ?? '',
              false,
              workspace.root,
              query.environmentId
            );
            return (
              scan.resources.find((candidate) => candidate.key === params.key) ??
              missingResourceResponse(scan, ref.kind)
            );
          } catch (error) {
            return handleLibraryError(error, set);
          }
        }
      )
      .get(
        '/library/locations',
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
        },
        async ({ query, set, user }) => {
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot);
          if (!workspace.ok) return workspace.failure;
          try {
            return await service.listLocations(user?.id ?? '', workspace.root, query.environmentId);
          } catch (error) {
            return handleLibraryError(error, set);
          }
        }
      )
      // The coverage matrix has one column per target, and that column set has to
      // be stable even when a filter leaves no rows to infer it from.
      .get(
        '/library/targets',
        {
          response: { 200: LibraryTargetDescriptorListSchema },
        },
        () => service.listTargets()
      )
      .post(
        '/library/rescan',
        {
          query: t.Object({
            force: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
            workspaceRoot: WorkspaceRootSchema,
            environmentId: EnvironmentIdQuerySchema,
          }),
          response: {
            200: LibraryScanResultSchema,
            422: ApiErrorResponseSchema,
            500: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
        },
        async ({ query, set, user }) => {
          const workspace = await resolveWorkspaceRoot(query.workspaceRoot);
          if (!workspace.ok) return workspace.failure;
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
        }
      )
  );
}

export const libraryRoutes = createLibraryRoutes();
