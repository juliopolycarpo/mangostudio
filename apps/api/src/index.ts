/**
 * MangoStudio API server entry point.
 * Elysia-based server running on Bun with Kysely SQLite persistence.
 */

import { staticPlugin } from '@elysiajs/static';
import { join } from 'path';
import { existsSync } from 'fs';
import { Migrator } from 'kysely';

import { getDb, closeDb } from './db/database';
import { initialSchema } from './db/migrations/001_initial_schema';
import { addInteractionMode } from './db/migrations/002_add_interaction_mode';
import { addSecretMetadata } from './db/migrations/003_add_secret_metadata';
import { addIndexes } from './db/migrations/004_add_indexes';
import { multiConnectors } from './db/migrations/005_multi_connectors';
import { authTables } from './db/migrations/006_auth_tables';
import { addUserOwnership } from './db/migrations/007_add_user_ownership';
import { getDefaultFrontendDir } from './lib/runtime-paths';
import { getConfig } from './lib/config';
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
        return {
          '001_initial_schema': initialSchema,
          '002_add_interaction_mode': addInteractionMode,
          '003_add_secret_metadata': addSecretMetadata,
          '004_add_indexes': addIndexes,
          '005_multi_connectors': multiConnectors,
          '006_auth_tables': authTables,
          '007_add_user_ownership': addUserOwnership,
        };
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
    // Register GET / and /index.html explicitly before staticPlugin so these
    // routes always take precedence, regardless of the plugin's internal HTML
    // handling behaviour (which varies between Bun compiled binaries and dev).
    .get('/', serveIndex)
    .get('/index.html', serveIndex)
    .use(
      staticPlugin({
        assets: FRONTEND_DIR,
        prefix: '/',
        ignorePatterns: ['/api/*', '/uploads/*', '/scalar'],
      })
    )
    .get('/*', async (context) => {
      // Don't intercept API/uploads/scalar/assets routes
      if (
        context.path.startsWith('/api/') ||
        context.path.startsWith('/uploads/') ||
        context.path.startsWith('/scalar') ||
        context.path.startsWith('/assets/')
      ) {
        return new Response('Not Found', { status: 404 });
      }
      return serveIndex();
    });
} else {
  // If no frontend, at least return 404 for non-matched routes
  app.all('/*', (context) => {
    if (context.path.startsWith('/api/')) return new Response('Not Found', { status: 404 });
    return new Response('Frontend not found. API is running.', { status: 404 });
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
