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
                      --json prints the status document (status only).
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
                      (read-only).
  env install <recipe> [--environment <id>] [--version <spec>] [--user <email>] [--json]
                      Run an install recipe on this machine. --environment
                      is accepted but always refused for now (no session
                      to check a paired environment against). --version
                      sets a Node spec for a node-version recipe. Requires
                      installs to be enabled (config.toml [environments]
                      installs_enabled = true). Exits 0 on success, 1 on
                      failure, 2 when the recipe never started.
  env update <recipe> [--environment <id>] [--json]
                      Same as env install, restricted to update recipes.
  env toolchain [node|bun <path|auto>] [--environment <id>] [--user <email>]
                      Show or set which Node and Bun spawned processes run
                      with on an environment. A path must be one the probe
                      reported; --user picks the account when the hub has
                      more than one.
  library [locations] [--kind <kind>] [--divergent] [--json]
                      Library coverage matrix and location health (read-only).
  upgrade [--check] [--yes] [--stable | --canary [<sha7>] | --version <x.y.z>]
          [--rollback] [--no-restart] [--json]
                      Upgrade this install, or hand off to the package
                      manager that owns it. --check previews without
                      downloading. Without --yes, an interactive terminal
                      confirms before downloading and again before
                      restarting a live hub; anywhere else it just reports
                      what is available and exits 0. --rollback returns to
                      the version before the last upgrade. --no-restart
                      leaves a live hub running the old build. --json prints
                      the report only. update is an alias.
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
  mangostudio upgrade          Check for and install an update
  mangostudio upgrade --check  Report what is available, without installing
  mangostudio upgrade --yes    Upgrade without any confirmation prompt
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
