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

await dispatch(extractUserArgs(process.argv));
