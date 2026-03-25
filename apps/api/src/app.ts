/**
 * MangoStudio API Core Application
 * Contains all Elysia routes and plugins, separated from server instantiation
 * for proper Eden type inference in the frontend.
 */

import { Elysia } from 'elysia';
import { staticPlugin } from '@elysiajs/static';
import { openapi } from '@elysiajs/openapi';
import { cors } from '@elysiajs/cors';

import { chatRoutes } from './routes/chats';
import { messageRoutes } from './routes/messages';
import { uploadRoutes } from './routes/upload';
import { generateRoutes } from './routes/generate';
import { respondRoutes } from './routes/respond';
import { settingsRoutes } from './routes/settings';
import { authRoutes } from './routes/auth';
import { rateLimit } from './plugins/rate-limit';
import { getDefaultUploadsDir } from './lib/runtime-paths';

const UPLOADS_DIR = process.env.UPLOADS_DIR || getDefaultUploadsDir();

/**
 * Base API instance with /api prefix.
 * Separating this ensures Eden Treaty correctly identifies /api as a namespace.
 */
const api = new Elysia({ prefix: '/api' })
  // Health check
  .get('/health', () => ({ status: 'ok', timestamp: Date.now() }))
  // Rate limiting for API routes
  .use(
    rateLimit({
      max: 100,
      windowMs: 60000,
      skip: (path) => path === '/health' || path.startsWith('/auth'),
    })
  )
  // Register features
  .use(authRoutes)
  .use(chatRoutes)
  .use(messageRoutes)
  .use(uploadRoutes)
  .use(generateRoutes)
  .use(respondRoutes)
  .use(settingsRoutes);

/**
 * Main application instance.
 */
export const app = new Elysia()
  .onRequest(({ request }) => {
    // Only log API and auth requests to avoid spamming frontend assets logs
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) {
      console.log(`[request] ${request.method} ${url.pathname}`);
    }
  })
  // Enable CORS for frontend requests
  .use(
    cors({
      origin: [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:5174',
        'http://127.0.0.1:5174',
      ],
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
