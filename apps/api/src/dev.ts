/**
 * Dev-only CLI entry (`bun run dev`). Separate from `index.ts` — the binary
 * entry — so the frontend build never reaches a compiled binary, which ships
 * the frontend embedded and must not shell out to a bundler.
 *
 * Same shape as `index.ts` otherwise: `wireTypeboxNamespaces()` must run
 * before the first schema is built, so `../app` (and everything it pulls in)
 * is loaded dynamically, after that call, rather than as a static import.
 */

import { extractUserArgs } from './cli/argv';
import { dispatch } from './cli/dispatch';
import { wireTypeboxNamespaces } from './lib/typebox-runtime';

wireTypeboxNamespaces();

const { registerDevFrontend } = await import('./server/dev-frontend');
await registerDevFrontend();

await dispatch(extractUserArgs(process.argv));
