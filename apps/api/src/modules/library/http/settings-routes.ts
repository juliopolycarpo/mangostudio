import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
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
import { inspectAllSettings, inspectSettingsTarget } from '../application/settings-inspection';
import { compareSettingsSnapshots } from '../domain/settings-concepts';

export interface SettingsRouteService {
  list(): SettingsSnapshot[];
  get(targetId: LibraryTargetId): SettingsSnapshot;
  compare(): ConceptComparison[];
}

const defaultSettingsRouteService: SettingsRouteService = {
  list: inspectAllSettings,
  get: inspectSettingsTarget,
  compare() {
    return compareSettingsSnapshots(inspectAllSettings());
  },
};

export function createSettingsRoutes(service: SettingsRouteService = defaultSettingsRouteService) {
  return new Elysia()
    .use(requireAuth)
    .get(
      '/library/settings',
      ({ set }): SettingsSnapshot[] | ApiErrorResponse => {
        try {
          return service.list();
        } catch (error) {
          return handleSettingsError(error, set);
        }
      },
      {
        response: {
          200: SettingsSnapshotListSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/library/settings/compare',
      ({ set }): ConceptComparison[] | ApiErrorResponse => {
        try {
          return service.compare();
        } catch (error) {
          return handleSettingsError(error, set);
        }
      },
      {
        response: {
          200: ConceptComparisonListSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/library/settings/:targetId',
      ({ params, set }): SettingsSnapshot | ApiErrorResponse => {
        try {
          return service.get(params.targetId);
        } catch (error) {
          return handleSettingsError(error, set);
        }
      },
      {
        params: t.Object({ targetId: LibraryTargetIdSchema }),
        response: {
          200: SettingsSnapshotSchema,
          500: ApiErrorResponseSchema,
        },
      }
    );
}

function handleSettingsError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  console.error('[library-settings] Unexpected error:', error);
  set.status = 500;
  return {
    error: 'Unexpected library settings inspection error.',
    code: ERROR_CODES.INTERNAL,
  };
}

export const librarySettingsRoutes = createSettingsRoutes();
