/**
 * Settings routes — thin composition layer.
 * Assembles connector CRUD, unified model catalog, and Gemini-specific aliases
 * under the /settings group.
 */

import type { Elysia } from 'elysia';
import '../../services/providers'; // ensure all providers are registered
import '../../services/tools'; // ensure all tools are registered
import { agentRoutes } from '../../modules/agents/http/agent-routes';
import { appSettingsRoutes } from '../../modules/app-settings/http/app-settings-routes';
import { connectorRoutes } from '../../modules/connectors/http/connectors-routes';
import { geminiAliasRoutes } from '../../modules/connectors/http/gemini-aliases-routes';
import { observabilityRoutes } from '../../modules/observability/http/observability-routes';
import { ruleFileRoutes } from '../../modules/prompt-rules/http/rule-file-routes';
import { providerSettingsRoutes } from '../../modules/provider-settings/http/provider-settings-routes';
import { toolSettingsRoutes } from '../../modules/tool-settings/http/tool-settings-routes';
import { modelRoutes } from './models';

export const settingsRoutes = (app: Elysia) =>
  app.group('/settings', (app) =>
    app
      .use(appSettingsRoutes)
      .use(agentRoutes)
      .use(connectorRoutes)
      .use(modelRoutes)
      .use(providerSettingsRoutes)
      .use(toolSettingsRoutes)
      .use(observabilityRoutes)
      .use(ruleFileRoutes)
      .use(geminiAliasRoutes)
  );
