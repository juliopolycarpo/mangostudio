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
  status [--json]     Show whether a server is running and its details.
                      --json prints the machine-readable status document.
  stop                Gracefully stop the running server.
  restart             Restart the server the way it was started: through
                      the service when one is installed, else as a new
                      background instance.
  killserver          Force-kill the running server.
  service <action> [host|port|host:port] [--json]
                      Keep the server running across logout and reboot.
                      Actions: install, uninstall, status, start, stop,
                      restart. Uses a systemd user unit, a launchd agent,
                      or a Windows Scheduled Task.
  logs [-f] [-n <count>]
                      Print the last lines of the server log; -f follows.
  open                Open the running server in the default browser.
  doctor [--all] [--chatgpt-refresh] [--probe] [--env] [--library] [--json]
                      Run environment and configuration diagnostics.
                      ChatGPT connector checks run when the connector is
                      configured, or with --all. --chatgpt-refresh performs a
                      live token refresh (rotates the stored refresh token).
                      --probe actively connects to each enabled MCP server.
                      --env or --library limit extra sections; --json prints
                      JSON.
  env [runtimes|agents] [--json]
                      Report runtimes, version managers, and agent CLIs
                      (read-only; no install).
  library [locations] [--kind <kind>] [--divergent] [--json]
                      Library coverage matrix and location health (read-only).
  version, --version  Print the MangoStudio version.
  help                Show this help.

Examples:
  mangostudio serve            Start in the foreground on port 3001
  mangostudio serve 3000       Start in the foreground on port 3000
  mangostudio serve lan:3000   Start on all LAN interfaces, port 3000
  mangostudio serve -d         Start in the background
  mangostudio serve 3000 -d    Start in the background on port 3000
  mangostudio service install  Start now and again after every login
  mangostudio restart          Restart the running server
  mangostudio logs -f          Follow the server log
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
