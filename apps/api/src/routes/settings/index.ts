/**
 * Settings routes — thin composition layer.
 * Assembles connector CRUD, unified model catalog, and Gemini-specific aliases
 * under the /settings group.
 */

import { Elysia } from 'elysia';
import '../../services/providers'; // ensure all providers are registered
import { connectorRoutes } from './connectors';
import { modelRoutes } from './models';
import { geminiAliasRoutes } from './gemini-aliases';

export const settingsRoutes = (app: Elysia) =>
  app.group('/settings', (app) => app.use(connectorRoutes).use(modelRoutes).use(geminiAliasRoutes));
