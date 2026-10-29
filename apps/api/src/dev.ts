/**
 * Dev-only CLI entry (`bun run dev`). Separate from `index.ts` — the binary
 * entry — so the frontend build never reaches a compiled binary, which ships
 * the frontend embedded and must not shell out to a bundler.
 *
 * Register the development frontend before dispatch loads the selected command.
 */

import { extractUserArgs } from './cli/argv';
import { dispatch } from './cli/dispatch';

const { registerDevFrontend } = await import('./server/dev-frontend');
await registerDevFrontend();

await dispatch(extractUserArgs(process.argv));
