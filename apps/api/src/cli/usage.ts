/**
 * Plain-text help and usage output for the CLI (user-facing — never JSON).
 */

import { writeError, writeLine } from './output';

const HELP = `MangoStudio — AI image generation and chat studio

Usage:
  mangostudio <command> [options]

Commands:
  serve [host|port|host:port] [-d]
                      Start the server (default localhost:3001).
                      Host aliases: lan, all, any, public => 0.0.0.0; local => 127.0.0.1.
                      -d / --detach runs it in the background.
  status              Show whether a server is running and its details.
  stop                Gracefully stop the running server.
  killserver          Force-kill the running server.
  doctor              Run environment and configuration diagnostics.
  version, --version  Print the MangoStudio version.
  help                Show this help.

Examples:
  mangostudio serve            Start in the foreground on port 3001
  mangostudio serve 3000       Start in the foreground on port 3000
  mangostudio serve lan:3000   Start on all LAN interfaces, port 3000
  mangostudio serve -d         Start in the background
  mangostudio serve 3000 -d    Start in the background on port 3000
  mangostudio --version
  mangostudio status
  mangostudio stop`;

/** Print full help/usage to stdout. // Usage: printHelp() */
export function printHelp(): void {
  writeLine(HELP);
}

/** Print an unknown-command notice to stderr. // Usage: printUnknown('foo') */
export function printUnknown(command: string): void {
  writeError(`Unknown command: ${command}`);
}
