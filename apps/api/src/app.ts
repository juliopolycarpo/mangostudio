/**
 * MangoStudio API Core Application
 * Contains all Elysia routes and plugins, separated from server instantiation
 * for proper Eden type inference in the frontend.
 */

import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { staticPlugin } from '@elysiajs/static';
import { Elysia } from 'elysia';
import { getConfig } from './lib/config';
import { createDiagnosticLogger } from './lib/logger';
import { chatRoutes } from './modules/chats/http/chat-routes';
import { capabilityRoutes } from './modules/generation/http/capability-routes';
import { generateRoutes } from './modules/generation/http/generate-routes';
import { respondRoutes } from './modules/generation/http/respond-routes';
import { respondStreamRoutes } from './modules/generation/http/respond-stream-routes';
import { turnRecoveryRoutes } from './modules/generation/http/turn-recovery-routes';
import { gitRoutes } from './modules/git/http/git-routes';
import { mcpServerRoutes } from './modules/mcp-servers/http/mcp-server-routes';
import { messageRoutes } from './modules/messages/http/message-routes';
import { skillRoutes } from './modules/skills/http/skill-routes';
import { todoRoutes } from './modules/todos/http/todo-routes';
import { workspaceRoutes } from './modules/workspaces/http/workspace-routes';
import { errorHandler } from './plugins/error-handler';
import { rateLimit } from './plugins/rate-limit';
import { classifyRateLimit } from './plugins/rate-limit-policy';
import { authRoutes } from './routes/auth';
import { createGeneratedImageRoutes } from './routes/generated-images';
import { settingsRoutes } from './routes/settings';
import { uploadRoutes } from './routes/upload';
import { registerApplicationServices } from './services/register-application-services';

registerApplicationServices();

const UPLOADS_DIR = getConfig().uploads.dir;
const IMAGES_DIR = getConfig().images.dir;
const requestLogger = createDiagnosticLogger('request');

/**
 * Base API instance with /api prefix.
 * Separating this ensures Eden Treaty correctly identifies /api as a namespace.
 */
const api = new Elysia({ prefix: '/api' })
  // Centralized error handling
  .use(errorHandler)
  // Rate limiting with per-route-group buckets. `classifyRateLimit` routes
  // health and auth into their own generous buckets so they are not gated by
  // the general API limit, while everything else shares the baseline bucket.
  // `trustProxy` lets proxied deployments (e.g. Docker behind nginx) resolve
  // the real client IP from forwarded headers; off by default (see config).
  .use(rateLimit({ classify: classifyRateLimit, trustProxy: getConfig().security.trustProxy }))
  // Health check — covered by its own generous bucket (registered after the
  // limiter so the limiter's hooks apply to it).
  .get('/health', () => ({ status: 'ok', timestamp: Date.now() }))
  // Register features
  .use(authRoutes)
  .use(chatRoutes)
  .use(capabilityRoutes)
  .use(todoRoutes)
  .use(messageRoutes)
  .use(uploadRoutes)
  .use(generateRoutes)
  .use(respondRoutes)
  .use(respondStreamRoutes)
  .use(turnRecoveryRoutes)
  .use(gitRoutes)
  .use(settingsRoutes)
  .use(skillRoutes)
  .use(mcpServerRoutes)
  .use(workspaceRoutes);

/**
 * Main application instance.
 */
export const app = new Elysia()
  .onRequest(({ request }) => {
    // Only log API and auth requests to avoid spamming frontend assets logs
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) {
      requestLogger.info('received', { method: request.method, path: url.pathname });
    }
  })
  // Enable CORS for frontend requests
  .use(
    cors({
      origin: getConfig().corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
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
  // OpenAPI/Scalar documentation
  .use(
    openapi({
      path: '/scalar',
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
