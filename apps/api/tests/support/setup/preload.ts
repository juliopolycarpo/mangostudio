/**
 * Bun test preload (configured in `apps/api/bunfig.toml`). It runs before any
 * test module loads and delegates to the shared `setupTestEnvironment()` so the
 * preload and the test harness agree on a single bootstrap.
 *
 * NOTE: `bunfig.toml` is resolved relative to the current working directory, so
 * this preload only runs when tests start from `apps/api` (e.g. via
 * `bun run --filter @mangostudio/api test:unit`). The config safety net in
 * `src/lib/config.ts` and the harness guard keep wrong-directory runs safe and
 * loud. See docs/reference/testing.md.
 */

import { setupTestEnvironment } from './test-environment';

await setupTestEnvironment();
