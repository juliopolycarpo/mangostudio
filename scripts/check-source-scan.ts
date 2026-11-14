// Runs one of `bun run check`'s source scans in its own process.
// Usage: bun ./scripts/check-source-scan.ts shared-import-boundary

import { resolveSourceScan } from './lib/source-scans';

try {
  await resolveSourceScan(process.argv.slice(2))();
} catch (caught) {
  console.error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
