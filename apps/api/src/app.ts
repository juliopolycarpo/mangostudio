/**
 * MangoStudio API Core Application
 * Contains all Elysia routes and plugins, separated from server instantiation
 * for proper Eden type inference in the frontend.
 */

import { mkdirSync } from 'node:fs';
import { cors } from '@elysia/cors';
import { openapi } from '@elysia/openapi';
import { staticPlugin } from '@elysia/static';
import { Elysia, NotFound } from 'elysia';
import { websocket } from 'elysia/websocket';
import { getConfig } from './lib/config';
import { createDiagnosticLogger } from './lib/logger';
import { activityRoutes } from './modules/activity/http/activity-routes';
import { apiKeyRoutes } from './modules/api-keys/http/api-key-routes';
import { chatRoutes } from './modules/chats/http/chat-routes';
import { environmentRoutes } from './modules/environments/http/environment-routes';
import { runtimeSocketRoutes } from './modules/environments/http/runtime-socket-routes';
import { externalAgentRoutes } from './modules/external-agents/http/external-agent-routes';
import { externalAgentTurnRoutes } from './modules/external-agents/http/external-agent-turn-routes';
import { externalSessionRoutes } from './modules/external-agents/http/external-session-routes';
import { fileCheckpointRoutes } from './modules/file-checkpoints/http/file-checkpoint-routes';
import { capabilityRoutes } from './modules/generation/http/capability-routes';
import { generateRoutes } from './modules/generation/http/generate-routes';
import { respondRoutes } from './modules/generation/http/respond-routes';
import { respondStreamRoutes } from './modules/generation/http/respond-stream-routes';
import { turnRecoveryRoutes } from './modules/generation/http/turn-recovery-routes';
import { gitRoutes } from './modules/git/http/git-routes';
import { githubRoutes } from './modules/github/http/github-routes';
import { libraryRoutes } from './modules/library/http/library-routes';
import { propagationRoutes } from './modules/library/http/propagation-routes';
import { removalRoutes } from './modules/library/http/removal-routes';
import { librarySettingsRoutes } from './modules/library/http/settings-routes';
import { machineRoutes } from './modules/machine/http/machine-routes';
import { mcpServerRoutes } from './modules/mcp-servers/http/mcp-server-routes';
import { messageRoutes } from './modules/messages/http/message-routes';
import {
  REALTIME_WEBSOCKET_OPTIONS,
  realtimeRoutes,
} from './modules/realtime/http/realtime-routes';
import { skillRoutes } from './modules/skills/http/skill-routes';
import { terminalRoutes } from './modules/terminals/http/terminal-routes';
import { terminalSocketRoutes } from './modules/terminals/http/terminal-socket-routes';
import { todoRoutes } from './modules/todos/http/todo-routes';
import { toolIdentityRoutes } from './modules/tool-identity/http/tool-identity-routes';
import { workspaceRoutes } from './modules/workspaces/http/workspace-routes';
import { apiKeyGuard } from './plugins/api-key-guard';
import { errorHandler } from './plugins/error-handler';
import { rateLimit } from './plugins/rate-limit';
import { classifyRateLimit } from './plugins/rate-limit-policy';
import { authRoutes } from './routes/auth';
import { createGeneratedImageRoutes } from './routes/generated-images';
import { settingsRoutes } from './routes/settings';
import { uploadRoutes } from './routes/upload';
import { frontendNotFound } from './server/frontend-fallback';
import { OPENAPI_PATH, openapiProblemDetails } from './server/openapi-problem-details';
import { registerApplicationServices } from './services/register-application-services';

registerApplicationServices();

const UPLOADS_DIR = getConfig().uploads.dir;
const IMAGES_DIR = getConfig().images.dir;
const requestLogger = createDiagnosticLogger('request');

// `staticPlugin` enumerates its assets directory when the server starts, and a
// missing one fails the listen rather than serving nothing. The uploads route
// module creates this directory as an import side effect, which happens to run
// first today — this does not rely on that ordering holding.
mkdirSync(UPLOADS_DIR, { recursive: true });

/**
 * Base API instance with /api prefix.
 * Separating this ensures Eden Treaty correctly identifies /api as a namespace.
 */
const api = new Elysia({ prefix: '/api' })
  // Centralized error handling
  .use(errorHandler)
  // Rate limiting with per-route-group buckets. `classifyRateLimit` routes
  // health and auth into their own generous buckets, key-authenticated traffic
  // into `api-key`, and everything else into the baseline `general` bucket.
  // `trustProxy` lets proxied deployments (e.g. Docker behind nginx) resolve
  // the real client IP from forwarded headers; off by default (see config).
  .use(rateLimit({ classify: classifyRateLimit, trustProxy: getConfig().security.trustProxy }))
  // Health check — covered by its own generous bucket (registered after the
  // limiter so the limiter's hooks apply to it).
  .get('/health', () => ({ status: 'ok', timestamp: Date.now() }))
  // Authenticates `x-api-key` requests before any route sees them; a no-op
  // for cookie-session traffic. Runs once per request here, rather than as
  // part of authMiddleware (re-registered per route module and never sees
  // /api/auth/**).
  .use(apiKeyGuard)
  // Register features
  .use(authRoutes)
  .use(apiKeyRoutes)
  .use(realtimeRoutes)
  // A peer endpoint rather than a bus topic: paired runtimes dial in here with
  // a machine credential, not a session cookie.
  .use(runtimeSocketRoutes)
  .use(chatRoutes)
  .use(activityRoutes)
  .use(environmentRoutes)
  .use(machineRoutes)
  .use(externalAgentRoutes)
  .use(externalAgentTurnRoutes)
  .use(externalSessionRoutes)
  .use(capabilityRoutes)
  .use(todoRoutes)
  .use(fileCheckpointRoutes)
  .use(messageRoutes)
  .use(uploadRoutes)
  .use(generateRoutes)
  .use(respondRoutes)
  .use(respondStreamRoutes)
  .use(turnRecoveryRoutes)
  .use(gitRoutes)
  .use(githubRoutes)
  .use(libraryRoutes)
  .use(librarySettingsRoutes)
  .use(propagationRoutes)
  .use(removalRoutes)
  .use(settingsRoutes)
  .use(skillRoutes)
  .use(mcpServerRoutes)
  .use(toolIdentityRoutes)
  .use(workspaceRoutes)
  .use(terminalRoutes)
  .use(terminalSocketRoutes);

/**
 * Main application instance.
 */
export const app = new Elysia()
  // WebSocket support is a plugin in Elysia 2 rather than constructor options.
  // Registered on the outer app, before the route plugins that open sockets, so
  // both the realtime and runtime-pairing protocols inherit one option set.
  .use(websocket(REALTIME_WEBSOCKET_OPTIONS))
  // Seated ahead of the API error plugin on purpose. Elysia walks `NotFound`
  // handlers in registration order and stops at the first that returns
  // something; the frontend is only wired up at server start, long after this
  // module is evaluated, so its own handler would never be reached. This one
  // defers (returns nothing) for anything the frontend does not claim, leaving
  // API 404s to answer with `ApiErrorResponse` as before.
  .error(NotFound, ({ request }) => frontendNotFound(request))
  .request(({ request }) => {
    // Only log API and auth requests to avoid spamming frontend assets logs
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) {
      requestLogger.info('received', { method: request.method, path: url.pathname });
    }
  })
  // Enable CORS for frontend requests. The origin check is a function, not a
  // snapshot of `getConfig().corsOrigins`: this module is evaluated once per
  // process, and an array captured here would bind the CORS gate to whatever
  // config happened to be live at first import — under the shared-module-graph
  // test lane, that is whichever test file imported the app first. Entries are
  // validated to be canonical `scheme://host[:port]` origins, so the exact
  // string comparison the config module promises is the whole check; a `true`
  // return makes the plugin echo the request's Origin with `Vary: Origin`.
  .use(
    cors({
      origin: (request) => {
        const requestOrigin = request.headers.get('Origin');
        return requestOrigin !== null && getConfig().corsOrigins.includes(requestOrigin);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
    })
  )
  // Serve uploaded files as static assets
  .use(
    staticPlugin({
      assets: UPLOADS_DIR,
      prefix: '/uploads',
    })
  )
  .use(createGeneratedImageRoutes(IMAGES_DIR))
  // Adds the negotiated `application/problem+json` media type to the generated
  // document, and classifies the spec route's own failures — `errorHandler` is
  // mounted inside `api` below, too late to reach them, and the plugin's local
  // error hook would otherwise let Elysia answer with the raw exception message.
  // Seated before `openapi` on purpose — a global hook only reaches routes
  // declared after it, and the spec route is declared by that plugin.
  .use(openapiProblemDetails)
  // OpenAPI/Scalar documentation
  .use(
    openapi({
      path: OPENAPI_PATH,
      documentation: {
        info: {
          title: 'MangoStudio API',
          version: '1.0.0',
          description: 'MangoStudio API documentation generated with Elysia OpenAPI',
        },
      },
    })
  )
  // Mount API
  .use(api);

export type App = typeof app;
