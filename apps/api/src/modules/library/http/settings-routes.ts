import { EnvironmentIdSchema, LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { ApiErrorResponseSchema } from '@mangostudio/shared/errors';
import {
  type ConceptComparison,
  ConceptComparisonListSchema,
  type LibraryTargetId,
  LibraryTargetIdSchema,
  type SettingsSnapshot,
  SettingsSnapshotListSchema,
  SettingsSnapshotSchema,
} from '@mangostudio/shared/library';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  environmentLibraryService,
  type LibraryScope,
} from '../application/environment-library-service';
import { inspectAllSettings, inspectSettingsTarget } from '../application/settings-inspection';
import { compareSettingsSnapshots } from '../domain/settings-concepts';
import { handleLibraryError } from './library-error';

export interface SettingsRouteService {
  list(scope: LibraryScope): Promise<SettingsSnapshot[]>;
  get(scope: LibraryScope, targetId: LibraryTargetId): Promise<SettingsSnapshot>;
  compare(scope: LibraryScope): Promise<ConceptComparison[]>;
}

const defaultSettingsRouteService: SettingsRouteService = {
  async list(scope) {
    return inspectAllSettings(await environmentLibraryService.readSettingsSources(scope));
  },
  async get(scope, targetId) {
    return inspectSettingsTarget(
      targetId,
      await environmentLibraryService.readSettingsSources(scope)
    );
  },
  async compare(scope) {
    return compareSettingsSnapshots(
      inspectAllSettings(await environmentLibraryService.readSettingsSources(scope))
    );
  },
};

const environmentQuery = t.Object({ environmentId: t.Optional(EnvironmentIdSchema) });

function scopeFor(userId: string, environmentId: string | undefined): LibraryScope {
  return { userId, environmentId: environmentId ?? LOCAL_ENVIRONMENT_ID };
}

export function createSettingsRoutes(service: SettingsRouteService = defaultSettingsRouteService) {
  return new Elysia()
    .use(requireAuth)
    .get(
      '/library/settings',
      async ({ query, set, user }): Promise<SettingsSnapshot[] | ApiErrorResponse> => {
        try {
          return await service.list(scopeFor(user?.id ?? '', query.environmentId));
        } catch (error) {
          return handleLibraryError(error, set, '[library-settings]');
        }
      },
      {
        query: environmentQuery,
        response: {
          200: SettingsSnapshotListSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/library/settings/compare',
      async ({ query, set, user }): Promise<ConceptComparison[] | ApiErrorResponse> => {
        try {
          return await service.compare(scopeFor(user?.id ?? '', query.environmentId));
        } catch (error) {
          return handleLibraryError(error, set, '[library-settings]');
        }
      },
      {
        query: environmentQuery,
        response: {
          200: ConceptComparisonListSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/library/settings/:targetId',
      async ({ params, query, set, user }): Promise<SettingsSnapshot | ApiErrorResponse> => {
        try {
          return await service.get(scopeFor(user?.id ?? '', query.environmentId), params.targetId);
        } catch (error) {
          return handleLibraryError(error, set, '[library-settings]');
        }
      },
      {
        params: t.Object({ targetId: LibraryTargetIdSchema }),
        query: environmentQuery,
        response: {
          200: SettingsSnapshotSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
      }
    );
}

export const librarySettingsRoutes = createSettingsRoutes();
