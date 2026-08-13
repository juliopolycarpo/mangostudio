/**
 * MangoStudio CLI + server entry point (the compiled binary's entry).
 *
 * Parses the subcommand and dispatches: `serve` starts the server (foreground or
 * detached with -d), while `status`/`stop`/`killserver`/`doctor` manage it. The
 * server bootstrap itself lives in ./server/start-server.ts and is imported only
 * when a serve command runs, so management commands stay fast and side-effect free.
 */

import { extractUserArgs } from './cli/argv';
import { dispatch } from './cli/dispatch';
import { wireTypeboxNamespaces } from './lib/typebox-runtime';

// Before dispatch, because `serve` imports the routes that build the first
// schemas. A statement rather than an import side effect so import sorting
// cannot move it after the modules that depend on it.
wireTypeboxNamespaces();

await dispatch(extractUserArgs(process.argv));
