import { Elysia } from 'elysia';
import type {
  ProviderObservabilityLogsResponse,
  ProviderObservabilityMetricsResponse,
} from '@mangostudio/shared/observability';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  getProviderObservabilityLogs,
  getProviderObservabilityMetrics,
} from '../../../services/providers/core/provider-observability';

export const observabilityRoutes = new Elysia()
  .use(requireAuth)

  .get('/metrics', (): ProviderObservabilityMetricsResponse => {
    return getProviderObservabilityMetrics();
  })

  .get('/logs', (): ProviderObservabilityLogsResponse => {
    return getProviderObservabilityLogs();
  });
