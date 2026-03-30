/**
 * MangoStudio API server entry point.
 * Elysia-based server running on Bun with Kysely SQLite persistence.
 */

import { staticPlugin } from '@elysiajs/static';
import { join } from 'path';
import { existsSync } from 'fs';
import { Migrator } from 'kysely';

import { getDb, closeDb } from './db/database';
import { allMigrations } from './db/migrations';
import { getDefaultFrontendDir } from './lib/runtime-paths';
import { getConfig } from './lib/config';
import { isSpaRoute } from './lib/spa-guard';
import { app } from './app';

const PORT = getConfig().server.port;
const FRONTEND_DIR = getDefaultFrontendDir();

// Check if frontend directory exists
const frontendExists = (() => {
  try {
    return existsSync(FRONTEND_DIR) && existsSync(join(FRONTEND_DIR, 'index.html'));
  } catch (error) {
    console.warn('[frontend] Failed to inspect frontend directory:', error);
    return false;
  }
})();

console.log(
  frontendExists
    ? `[frontend] Serving from: ${FRONTEND_DIR}`
    : `[frontend] No frontend found at: ${FRONTEND_DIR}`
);

/**
 * Runs database migrations before starting the server.
 */
async function runMigrations(): Promise<void> {
  const db = getDb();
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return allMigrations;
      },
    },
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`[migrate] ✓ "${it.migrationName}"`);
    } else if (it.status === 'Error') {
      console.error(`[migrate] ✗ "${it.migrationName}" failed`);
    }
  });

  if (error) {
    console.error('[migrate] Migration failed:', error);
    process.exit(1);
  }
}

// Run migrations, then start server
await runMigrations();

// Add Frontend and SPA fallback if it exists
if (frontendExists) {
  const indexPath = join(FRONTEND_DIR, 'index.html');
  const serveIndex = () =>
    new Response(Bun.file(indexPath), { headers: { 'Content-Type': 'text/html' } });

  app
    // Register GET / explicitly before staticPlugin. The static plugin may
    // register GET / with an undefined handler when running inside a compiled
    // Bun binary (htmlBundle.default is undefined for Vite-generated HTML),
    // so this explicit route guarantees that GET / always returns index.html.
    .get('/', serveIndex)
    .use(
      staticPlugin({
        assets: FRONTEND_DIR,
        prefix: '/',
        // ignorePatterns in @elysiajs/static v1.4.7 has an inverted comparison
        // (pattern.includes(file) instead of file.includes(pattern)), so string
        // patterns never match. Only regex patterns work: pattern.test(file).
        // Exclude index.html so the plugin does not register a GET /index.html
        // handler that fails in compiled Bun binaries (import() of Vite HTML
        // triggers Bun's HTML bundler, which can't resolve hashed asset paths).
        // GET /index.html is handled by the onError NOT_FOUND handler below.
        ignorePatterns: [/index\.html$/, '/api/*', '/uploads/*', '/scalar'],
      })
    )
    .onError(({ code, request }) => {
      if (code === 'NOT_FOUND' && request.method === 'GET') {
        const { pathname } = new URL(request.url);
        if (isSpaRoute(pathname)) {
          return new Response(Bun.file(indexPath), {
            headers: { 'Content-Type': 'text/html' },
          });
        }
      }
    });
} else {
  // If no frontend, return a clear 404 for all unmatched routes
  app.onError(({ code }) => {
    if (code === 'NOT_FOUND') {
      return new Response('Frontend not found. API is running.', { status: 404 });
    }
  });
}

app.listen(PORT);

console.log(`[api] MangoStudio API running on http://localhost:${PORT}`);
console.log(`[api] Scalar UI available at http://localhost:${PORT}/scalar`);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[api] Shutting down...');
  await closeDb();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeDb();
  process.exit(0);
});
