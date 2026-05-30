/**
 * MangoStudio API server entry point.
 * Elysia-based server running on Bun with Kysely SQLite persistence.
 */

import { startServer } from './server/start-server';

await startServer();
