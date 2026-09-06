# CLI Reference

MangoStudio ships as a single binary that doubles as a CLI for running and
managing one local server. The same commands work from the installed binary
(`mangostudio`) and from source (`bun run apps/api/src/index.ts <command>`).

## Install channels

Pick any distribution channel — each ships the same prebuilt binary and frontend
sidecar. See the [README install matrix](../../README.md#install) for
copy-paste commands, or:

| Channel            | Entry point                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm / bun          | `mangostudio` — see [`packages/cli/README.md`](../../packages/cli/README.md)                                                                                         |
| Homebrew           | `brew install juliopolycarpo/tap/mangostudio`                                                                                                                        |
| Shell / PowerShell | `install.sh` / `install.ps1` from [GitHub Releases](https://github.com/juliopolycarpo/mangostudio/releases/latest/download/install.sh) (mirrored at mangostudio.dev) |
| Scoop              | `juliopolycarpo/scoop-bucket` → `scoop install mangostudio`                                                                                                          |
| Cargo              | `cargo install mangostudio` — see [`packages/cargo-shim/README.md`](../../packages/cargo-shim/README.md)                                                             |
| Docker             | `ghcr.io/juliopolycarpo/mangostudio` — see [`docs/operations/deployment.md`](../operations/deployment.md#docker)                                                     |
| Manual             | Download platform archives from GitHub Releases and verify `SHA256SUMS`                                                                                              |

## Commands

| Command                                                                                                               | Description                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `mangostudio`                                                                                                         | Print help and the command list.                                                             |
| `serve [host\|port\|host:port]`                                                                                       | Start the server in the foreground (default `localhost:3001`).                               |
| `serve [host\|port\|host:port] -d`                                                                                    | Start the server in the background (detached) and return.                                    |
| `status`                                                                                                              | Show whether a server is running, its URL, launch mode, and health.                          |
| `status --json`                                                                                                       | Emit the shared hub status document instead of plain text.                                   |
| `stop`                                                                                                                | Gracefully stop the running server (SIGTERM).                                                |
| `restart`                                                                                                             | Restart the running server the way it was started.                                           |
| `killserver`                                                                                                          | Force-kill the running server (SIGKILL).                                                     |
| `service <action> [host\|port\|host:port] [--json]`                                                                   | Keep the server running across logout and reboot.                                            |
| `logs [-f] [-n <count>]`                                                                                              | Print the tail of the server log; `-f` follows it.                                           |
| `open`                                                                                                                | Open the running server in the default browser.                                              |
| `doctor`                                                                                                              | Run environment and configuration diagnostics.                                               |
| `doctor --all`                                                                                                        | Include ChatGPT connector checks even without a configured connector.                        |
| `doctor --chatgpt-refresh`                                                                                            | Perform a live ChatGPT token refresh probe (rotates the stored refresh token).               |
| `doctor --probe`                                                                                                      | Actively connect to each enabled MCP server (spawns children / hits URLs).                   |
| `doctor --env` / `--library`                                                                                          | Limit extra sections to environments and/or library (core checks always run).                |
| `doctor --json`                                                                                                       | Emit structured JSON (checks, warning/failure counts).                                       |
| `env [runtimes\|agents] [--json]`                                                                                     | Report runtimes, version managers, and agent CLIs (read-only).                               |
| `env install <recipe> [--environment <id>] [--version <spec>]`                                                        | Run an install recipe on this machine (`--environment` is currently always refused).         |
| `env update <recipe> [--environment <id>]`                                                                            | Same as `env install`, restricted to update recipes.                                         |
| `env toolchain [node\|bun <path\|auto>] [--environment <id>] [--user <email>]`                                        | Show or set which Node and Bun spawned processes run with on an environment.                 |
| `library [locations] [--json]`                                                                                        | Library coverage matrix and location health (read-only).                                     |
| `library --kind <kind>`                                                                                               | Filter resources by kind (`skill`, `subagent`, etc.).                                        |
| `library --divergent`                                                                                                 | List only resources whose copies disagree across locations.                                  |
| `upgrade [--check] [--yes] [--stable \| --canary [<sha7>] \| --version <x.y.z>] [--rollback] [--no-restart] [--json]` | Upgrade this install, or hand off to the package manager that owns it. `update` is an alias. |
| `version`, `--version`, `-v`                                                                                          | Print the embedded MangoStudio version.                                                      |

`-d` / `--detach` and the positional host/port target may be combined in any
order, e.g. `mangostudio serve 127.0.0.1:3000 -d`.

Host aliases: `lan`, `all`, `any`, and `public` bind `0.0.0.0`; `local` binds
`127.0.0.1`.

`status` probes `/api/health` and prints `ok`, `unreachable` or `unprobed`
beside the URL and the launch mode. The probe only ever fetches loopback — it
will not issue a request to an arbitrary address named in a local state file —
so a server bound to one explicit LAN address (`mangostudio serve
192.168.1.20:3001`) reports `unprobed`: nothing could be measured, which is not
the same as a server that failed to answer. A bind-all start (`lan:`, `0.0.0.0`)
is probed over loopback as usual. `status --json` prints the `HubProcessStatus`
document from
[`apps/shared/src/machine/schemas.ts`](../../apps/shared/src/machine/schemas.ts) —
the same shape `GET /api/machine/status` embeds, so a terminal and the
"This machine" page cannot disagree.

### service

`mangostudio service install` hands the server to the platform's per-user
supervisor, so it comes back after logout and reboot without a terminal open.
No root is needed for the unit itself.

| Action         | Description                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `install`      | Write, enable and start the unit. Takes an optional `host\|port\|host:port`. |
| `uninstall`    | Disable and remove the unit.                                                 |
| `status`       | Report unit name, installed, enabled, running, linger, and what it runs.     |
| `start`/`stop` | Drive the installed unit through its supervisor.                             |
| `restart`      | Ask the supervisor to bounce the unit.                                       |
| `--json`       | Machine-readable output (`status` only).                                     |

| OS      | Unit                                                                    |
| ------- | ----------------------------------------------------------------------- |
| Linux   | systemd user unit `~/.config/systemd/user/mangostudio.service`          |
| macOS   | launchd agent `~/Library/LaunchAgents/com.mangostudio.hub.plist`        |
| Windows | Scheduled Task `MangoStudio Hub` (Task Scheduler owns it; no unit file) |

The unit runs `serve` through whichever program survives an upgrade:

- **Installer layout** — the launcher the installer maintains,
  `~/.mango/dist/current/mangostudio` (`%LOCALAPPDATA%\mangostudio\current\mangostudio.exe`
  on Windows — the junction, never the `bin` shim: a `.cmd` would make the
  supervisor supervise `cmd.exe`), so a new version is picked up without
  touching the unit.
- **Package manager** — the resolved executable, wherever the manager put it.
  Not the manager's own launcher: the npm wrapper and the Cargo shim on Windows
  spawn the binary as a child, so a supervisor pointed at one would track the
  wrapper and not the hub.
- **Source checkout** — the workspace entry through Bun, with the directory
  `install` was run from as the unit's working directory.
- **Installer layout with no launcher yet** — this version's own directory. The
  install prints a note saying so; run `mangostudio service install` again after
  an upgrade.

The supervisor appends stdout and stderr to `~/.mango/logs/service.log`. On
Windows the task runs a hidden PowerShell wrapper that does that redirection
itself, because Task Scheduler captures nothing.

A unit file is written mode `0600`, but nothing secret goes in it regardless.
The environment is a positive list — the runtime configuration variables (the
same set a detached start forwards: `DATABASE_PATH`, `PUBLIC_URL`,
`ALLOWED_ORIGINS`, the storage directories and the rest, but never
`BETTER_AUTH_SECRET`), `PATH` (except on Windows, where the task
inherits the logon session's), `MANGO_HOME`, `TZ`, `LANG`, `LC_ALL`,
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, and the proxy variables
with any `user:password@` stripped — plus `MANGO_LOG_FILE` and
`MANGOSTUDIO_SERVICE_UNIT`, and `API_HOST`/`API_PORT` when `install` was given a
target. Everything else, the
auth secret and connector credentials included, loads from `~/.mango/.env` at
startup exactly as it does for `serve -d` (see
[How background mode works](#how-background-mode-works)). Because the unit has
no terminal to ask at, `install` runs the interactive auth-secret setup first,
while there still is one — and refuses outright when the secret is exported in
the calling shell and stored nowhere else. That case satisfies the setup (the
secret is valid) but leaves the unit unable to load it, so the supervisor would
report a successful install and the hub it starts would refuse to serve.

The configuration carried is the one the process building the unit is running
on. Installing from the "This machine" page or from a `restart` therefore
preserves what the running hub was configured with; `mangostudio service install`
typed into a fresh shell carries that shell's environment, so an env-only setting
exported somewhere else is not picked up. Put settings that must survive either
route in `config.toml` or `~/.mango/.env`.

`install` registers the unit before it touches what is serving. Installing can
fail for reasons that have nothing to do with the running hub — no session bus,
a `launchctl` refusal, a Scheduled Task command over the length limit — and
stopping first would leave you with neither a server nor a service. Once the
unit is up, the hand-over happens: an instance you started by hand is stopped
(the unit's own `serve` waits for whoever holds the state file rather than
refusing, so it takes the port as soon as that pid is gone), and one the service
already runs is restarted so it picks up the new unit. When the hand-started
instance will not stop within 10 s, `install` says the unit is installed and
asks for `mangostudio killserver`; the service takes over once that pid ends.

Restart policy follows each supervisor: `Restart=on-failure` with `RestartSec=5`
on systemd, `KeepAlive` on a non-zero exit with a 30-second throttle on launchd,
and `RestartCount 3` at one-minute intervals with no execution time limit for the
Scheduled Task. On Windows the task's PowerShell wrapper ends with
`exit $LASTEXITCODE`, because the pipeline that writes the log file would
otherwise report its own success and Task Scheduler would read every crash as a
clean run.

`service stop` means "not running until you start it again", and on macOS that
is `launchctl bootout` rather than a signal: `KeepAlive` on a non-zero exit
counts a signalled process as one to revive, so a `kill` would be undone after
the throttle interval. The plist stays in `~/Library/LaunchAgents`, so the job
still loads at the next login — the same thing `systemctl --user stop` leaves
behind. `service start` bootstraps it back into the domain.

On Linux a user unit stops at logout unless **linger** is enabled. `install`
attempts `loginctl enable-linger` and, when that needs root, prints the exact
line to run:

```bash
sudo loginctl enable-linger $USER
```

`systemctl --user` and `loginctl` need `XDG_RUNTIME_DIR` and
`DBUS_SESSION_BUS_ADDRESS`; a non-interactive `ssh host command` often carries
neither, and `service` refuses with a distinct error naming the prefix to use.

```bash
mangostudio service install          # start now and again after every login
mangostudio service install lan:3000 # bake a bind target into the unit
mangostudio service status --json
mangostudio service restart
```

### restart

`mangostudio restart` brings the server back the way it was started:

- **Started by the service** — the supervisor bounces the unit, and the CLI waits
  up to 20 s for a different, healthy pid to own the state file. "Healthy" is
  the `/api/health` answer where it can be reached; for a hub bound to one
  explicit LAN address the probe only ever fetches loopback, so a live pid
  owning the state file is the signal instead — the file is written once the
  port is bound. `serve -d` waits the same way.
- **Started with `serve -d`** — the instance is stopped, and once that is
  confirmed a successor is spawned that waits for the old pid
  (`MANGO_RESTART_WAIT_PID`) before binding the port.
- **Started in the foreground** — refused. The terminal owns that process; the
  message names its PID.
- **Nothing running** — the installed unit is started. With no unit installed,
  the error names `mangostudio serve -d` and `mangostudio service install`.

### logs

`mangostudio logs` prints the tail of the log file recorded in
`~/.mango/run/server.json`. When nothing is recorded — after a crash, say — the
newest `server-*.log` or `service.log` under `~/.mango/logs` stands in, so the
last run is still readable. The default is the last 100 lines; `-n` takes up to
10 000. `-f` follows the file, polling twice a second, and re-reads from the
start when it is rotated or truncated. A foreground `serve` writes to its
terminal, so there is nothing to tail.

### env install / env update

The CLI mirror of the Environments page's install flow, for the person typing
at this machine's own terminal rather than a browser. Both call the same
install service the API does — recipe ids, previews, download verification,
audit rows, everything in
[`docs/architecture/environment-installs.md`](../architecture/environment-installs.md)
applies unchanged.

```bash
mangostudio env install bun.install.official
mangostudio env install nvm.node.install --version 22
mangostudio env update bun.update --json
```

| Flag                 | Description                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--environment <id>` | Accepted for parity with the API; currently always refused (see below) — the CLI has no session to check a paired environment's `allowInstalls` against.                       |
| `--version <spec>`   | `lts`, `latest`, or a numeric version, for a recipe that takes a Node spec.                                                                                                    |
| `--user <email>`     | The account the run is recorded under and whose toolchain selection the installer starts with; omitted means the hub's only account, or a local sentinel when none exists yet. |
| `--json`             | Print the final `InstallRun` audit row instead of a plain summary.                                                                                                             |

### upgrade

`mangostudio upgrade` (alias `update`) first works out **who installed the
binary** and only then decides what to do. Three signals, in precedence order:
the launcher marker the npm wrapper and the Cargo shim set
(`MANGOSTUDIO_LAUNCHER`, `MANGOSTUDIO_LAUNCHER_PATH`), the `install-origin.json`
the install scripts write at the dist root, and the shape of the executable's
own path. A source checkout (`dev`) and a container refuse whatever launched
them. `status` prints the answer as `Installed via:`; `doctor` has an
`Installed via` row.

| Installed via                        | Stable                                   | Canary (latest)                                     | Canary `<sha7>`                                       |
| ------------------------------------ | ---------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| install script (`install.sh`/`.ps1`) | archive + embedded script                | rolling archive + embedded script                   | npm platform tarball + embedded script; musl: refused |
| npm / bun / pnpm                     | `<pm> … mangostudio@latest`              | `<pm> … mangostudio@canary`                         | `<pm> … mangostudio@<root>-canary.<sha7>`             |
| Homebrew                             | `brew upgrade mangostudio`               | refused → shell installer `--canary`                | refused                                               |
| Scoop                                | `scoop update mangostudio`               | refused → `install.ps1 -Canary`                     | refused                                               |
| Cargo                                | `cargo install mangostudio --locked`     | `cargo install mangostudio --version <root>-canary` | refused                                               |
| Docker                               | prints `docker pull ghcr.io/…:<version>` | prints `docker pull ghcr.io/…:canary`               | prints `docker pull ghcr.io/…:<root>-canary.<sha7>`   |
| source checkout                      | `git pull && bun run build`              | same                                                | same                                                  |

For an install-script layout the hub does the work itself: resolve the target
(no channel flag means the channel this build came from), download the archive
into `<dist>/.staging-<version>-<pid>/`, verify it (`SHA256SUMS` for release
archives, the registry's `dist.integrity` for an npm tarball), then write the
install script embedded in its own binary to a temp file and run it with
`--local <archive>` (`bash` on POSIX; `pwsh` when present, else
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, on
Windows). The script extracts, smokes `mangostudio --version`, moves the
`current` pointer, rewrites `install-origin.json` with `origin: upgrade`, and
prunes. No executable code is ever downloaded — only archives, verified before
the script sees them. The script receives `MANGOSTUDIO_INSTALL_ORIGIN=upgrade`,
`MANGOSTUDIO_INSTALL_DIR` (the detected dist root) and, when the origin record
names one, `MANGOSTUDIO_BIN_DIR`. A legacy layout (version directories with no
`current` and no origin record) is migrated by that first run. `--rollback`
runs the script with `--use <previousVersion>`; `--check` resolves and reports
without downloading. The two are refused together: a rollback resolves
nothing, so there is no preview to give, and running one under `--check` would
move the pointer.

Delegated commands (the package-manager rows) are **printed** by default. With
`--yes` they are **run** on macOS and Linux with the hub's allowlisted env
(never its secrets), and a live hub is then restarted the same way a
self-managed upgrade restarts it. Cargo's Unix shim is the restart target when
it announced itself, since `cargo install` has just replaced what this process's
own path points at and the shim `exec`s the new binary in place. Every other
manager re-execs this process's path: their launchers run the binary as a child,
whose pid the restart handshake would never match. On Windows the npm managers delete the
package that holds the running `mangostudio.exe`, so `--yes` there stops a live
hub first (a foreground hub is refused: press Ctrl-C in its terminal), then
hands the command to a detached waiter (`Wait-Process` on this pid and the
stopped hub's, then the manager, then — unconditionally, since a hub already
stopped for the upgrade needs recovering whether or not the manager succeeded
— `mangostudio restart` for a Scheduled Task or `mangostudio serve -d
<host:port>` for a detached instance) whose output lands in
`~/.mango/run/upgrade-<timestamp>.log`; the report names the log. The waiter
carries the hub's own runtime configuration so the comeback starts with the
secret and database it was running with, and clears those variables around the
manager step so the manager and its postinstall hooks never see them. With
`--no-restart` the hub is still stopped, and the report names the command that
brings it back. If the waiter cannot be spawned at all, nothing is installed
and the hub is started again from here. Scoop goes through the same waiter. Refusals always print the
exact command to run instead.

Restart: after the pointer moves, a live hub is restarted through the `current`
pointer — the service manager when a unit exists, otherwise a new detached
instance on the recorded host and port — so `mangostudio restart` on an
install-script layout always launches the new version. A foreground hub, or a
service-managed hub on Windows (a Scheduled Task cannot restart itself from
inside its own process), is reported as `manual`. `--no-restart` leaves the old
build running. Detached terminals end with the hub; remote runtimes reconnect on
their next call.

Prompts: without `--yes`, an interactive terminal confirms before downloading
and again before restarting a live hub; anywhere else `upgrade` reports what is
available, says `Re-run with --yes to install it.`, and exits `0`. `--json`
prints the `UpgradeReport` document from
[`apps/shared/src/updates/schemas.ts`](../../apps/shared/src/updates/schemas.ts)
and nothing else. Exit codes: `0` upgraded, already current, or a `--check`
preview; `1` refused (the report carries `reason` and `command`); `2` download,
verification or script failure (the script's output is relayed verbatim).

The hub checks for a newer release at most once every 24 hours from the
serving process and caches the answer in `~/.mango/run/update-check.json`.
`[updates] check = false` in `config.toml` (`MANGO_UPDATES_CHECK=false`) turns
it off; `[updates] channel` (`MANGO_UPDATES_CHANNEL`) picks `stable` or `canary`
instead of the build's own; `NO_UPDATE_NOTIFIER`, `DO_NOT_TRACK` and `CI` skip
it. `status` and `doctor` print `Update: x.y.z available — run: <command>` when
one is cached; `doctor` on a terminal performs the check itself when the cache
is stale or absent. The same answer feeds `GET /api/machine/update` and the
banner on the "This machine" page, whose Upgrade button streams
`POST /api/machine/upgrade` (loopback-only, like the other machine actions).

### env toolchain

The CLI mirror of the Toolchains tab's **Use this version** picker. With no
arguments it prints the selection for the environment (`auto` for both unless
one was pinned); with `node` or `bun` and a value it writes one through the
same service as `PUT /api/environments/:id/toolchain`, so a path is accepted
only when that environment's probe reported an installation at exactly that
path. The selection is per account and a terminal has no session, so the
account is the hub's only one, or the one `--user <email>` names.

```bash
mangostudio env toolchain
mangostudio env toolchain node /home/me/.nvm/versions/node/v22.13.0/bin/node
mangostudio env toolchain bun auto --environment dev-box --user me@example.com
```

See [`docs/features/environments.md`](../features/environments.md) for what
the selection changes.

`env install` accepts `install`, `use-version`, and `set-default` recipes;
`env update` accepts only `update` recipes — there is no `env uninstall` yet,
so an uninstall recipe is not reachable from the CLI in this pass. Installs
must be enabled first (`config.toml` `[environments] installs_enabled = true`,
or `MANGO_ENV_INSTALLS_ENABLED=true`); a container refuses too. Unlike the
guard a browser answers to, loopback is not part of it — a terminal on this
machine is definitionally local — but a remote `--environment` is always
refused, because the CLI has no signed-in session to check that environment's
`allowInstalls` against.

The flow prints the recipe preview (argv, writes, download origin/size/sha256,
whether it is runnable) and, for a blocked or copy-only recipe, the command to
run by hand instead — then exits `2` without starting anything. Otherwise it
starts the run and streams its log to stdout as it arrives, exiting `0` on
`succeeded` and `1` on any other terminal status.

The CLI process shares this machine's SQLite database with a running hub, but
not its in-process dedupe of active runs: two processes racing the same
recipe each spawn a child rather than one attaching to the other's.

## `mangostudio-runtime`

Every channel installs a second binary beside `mangostudio`. It is the execution
host for out-of-process environments. On this machine MangoStudio spawns it and
speaks its protocol over the child's pipes, so it must stay in the same directory
as the main binary — that is how MangoStudio finds it. On another machine you run
`connect` yourself and it reaches back.

| Command                       | Description                                                   |
| ----------------------------- | ------------------------------------------------------------- |
| `mangostudio-runtime --stdio` | Serve the runtime protocol over stdin/stdout (NDJSON frames). |
| `mangostudio-runtime connect` | Dial a MangoStudio hub over WebSocket and serve it.           |
| `mangostudio-runtime serve`   | Listen for a hub over WebSocket (Direct URL).                 |
| `mangostudio-runtime --help`  | Print usage. Bare invocation does the same.                   |
| `--version`, `-v`             | Print the runtime version.                                    |

`stdio` also works as a bare word (`mangostudio-runtime stdio`).

In `--stdio` mode stdout carries protocol frames and nothing else; every diagnostic
goes to stderr, which MangoStudio collects into its own logs. `mangostudio doctor`
reports whether this binary is present and whether its version matches the hub's —
a mismatch is refused at the protocol handshake, so reinstall rather than mixing
releases.

### `connect`

| Flag          | Description                                                               |
| ------------- | ------------------------------------------------------------------------- |
| `--hub <url>` | Hub endpoint, e.g. `wss://hub.example.com/api/runtime`. Remembered after. |
| `--token -`   | Read the pairing token from stdin.                                        |

Both come from the environment's card in MangoStudio, which issues the token and
prints the exact command. The token has no argv spelling on purpose — a command
line is readable by every process on the machine — so pass it on stdin or set
`MANGOSTUDIO_RUNTIME_TOKEN`. It is stored owner-only in
`~/.mango/runtime/remote/credentials.json`, and the hub URL in `runtime.json`
beside it, so later runs need no flags at all.

`connect` stays in the foreground and reconnects on its own, backing off after
each failure. It exits non-zero only when redialing cannot help: a revoked token,
a disabled environment, a protocol version the hub will not serve, or another
runtime that took the same environment over — two processes sharing one pairing
token would otherwise trade it back and forth forever, so the loser stops and
names the conflict. Keep it running under whatever supervises long-lived
processes on that machine, or install a user service:

```bash
printf %s "$TOKEN" | mangostudio-runtime connect --hub wss://hub.example.com/api/runtime --token -
mangostudio-runtime connect   # afterwards: reuses the stored hub URL and token
mangostudio-runtime service install --mode connect
```

`printf` and single quotes are neither `cmd.exe` nor PowerShell. On Windows, use
the environment variable, which keeps the secret out of argv the same way:

```powershell
$env:MANGOSTUDIO_RUNTIME_TOKEN='<token>'; mangostudio-runtime connect --hub wss://hub.example.com/api/runtime
```

The stored credential is owner-only on POSIX. On Windows `chmod` can only set the
read-only attribute, so `connect` reports that owner-only access was **not**
established rather than claiming a restriction it did not apply — restrict the
file yourself if other accounts use that machine.

Release drift is not a connection gate here: a remote runtime is not part of the
hub's own distribution, so only the protocol version has to match. A release that
differs from the hub's is reported on the environment card, so a binary that has
fallen behind is visible rather than merely tolerated.

### `serve`

| Flag                   | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `--listen <host:port>` | Bind address. A bare port binds `127.0.0.1`. Remembered after the first run.     |
| `--token -`            | Read the serve token from stdin (`env` reads `MANGOSTUDIO_RUNTIME_SERVE_TOKEN`). |

`serve` is the Direct URL half of a remote runtime: the hub dials this process instead of
the runtime dialing the hub. When neither `--token` nor `MANGOSTUDIO_RUNTIME_SERVE_TOKEN`
is set, a previous run's token is reused, or one is generated, stored owner-only beside the
pairing token in `~/.mango/runtime/remote/credentials.json`, and printed once to stderr.
Tokens supplied on stdin or via the environment are not written to disk.
`MANGOSTUDIO_RUNTIME_TOKEN` remains the pairing credential for `connect` only.

Binding anything other than loopback prints a warning: whoever holds the serve token gets
shell access on that machine. Put TLS in front with a reverse proxy when the dial leaves
a trusted network — the runtime itself does not terminate TLS. A second hub connection
supersedes the first.

```bash
mangostudio-runtime serve --listen 8787
mangostudio-runtime serve   # afterwards: reuses stored listen address and token
printf %s "$TOKEN" | mangostudio-runtime serve --listen 0.0.0.0:8787 --token -
```

### `service`

Install a user-level unit so `connect` or `serve` survives logout and reboot.
`ExecStart` points at the slot's `current` link, so the runtime has to be
installed into the slot first — `install` refuses rather than write a unit that
cannot start. See
[`docs/operations/remote-runtimes.md`](../operations/remote-runtimes.md) for
that prerequisite, linger, SSH session-bus workarounds, macOS launchd verbs, and
what the Windows Scheduled Task looks like.

| Subcommand / flag       | Description                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `install`               | Write and enable the unit (systemd user unit, launchd agent, or Scheduled Task).            |
| `uninstall`             | Disable and remove the unit.                                                                |
| `status`                | Report installed, enabled, running, linger (Linux), and whether `ExecStart` uses `current`. |
| `start` / `stop`        | Drive the installed unit through its supervisor.                                            |
| `restart`               | Bounce the installed unit.                                                                  |
| `--mode connect\|serve` | Required when both modes are configured; otherwise inferred.                                |
| `--json`                | Machine-readable output (`status` only).                                                    |

| OS      | Unit                                                   |
| ------- | ------------------------------------------------------ |
| Linux   | `~/.config/systemd/user/mangostudio-runtime.service`   |
| macOS   | `~/Library/LaunchAgents/com.mangostudio.runtime.plist` |
| Windows | Scheduled Task `MangoStudio runtime` (no unit file)    |

```bash
mangostudio-runtime service install --mode connect
mangostudio-runtime service status --json
mangostudio-runtime service restart
```

## Examples

```bash
mangostudio serve              # foreground on localhost:3001
mangostudio serve 3000         # foreground on localhost:3000
mangostudio serve 127.0.0.1 -d # background on 127.0.0.1:3001
mangostudio serve lan:3000 -d  # background on 0.0.0.0:3000
mangostudio service install    # start now and after every login
mangostudio restart            # bring it back the way it was started
mangostudio logs -f            # follow the server log
mangostudio open               # open the bound address in a browser
mangostudio --version
mangostudio status
mangostudio stop
```

## How background mode works

`serve -d` re-executes the same binary with a hidden `__serve` subcommand as a
detached child process (via `Bun.spawn` with `detached` + `unref`). The parent
redirects the child's stdout/stderr to a timestamped log file, waits for the
server to report healthy, prints the PID and log path, then exits. The child
keeps running independently.

The detached child does **not** inherit the parent shell's full environment: it
is launched with a minimal allowlist (runtime config plus the system/networking
variables the server needs) so connector secrets never land in a long-lived
process environment. The child instead loads provider keys from `~/.mango/.env`
on startup. Set provider keys such as `GEMINI_API_KEY` in `~/.mango/.env` rather
than exporting them in your shell — a shell-only export reaches a foreground
`serve` but is dropped by a background (`-d`) start.

ChatGPT connectors are different from API-key providers: they are created by
the Settings sign-in flow, store rotating tokens in the OS secret store, and use
the fixed loopback callback port `1455`. Endpoint overrides for smoke tests or
advanced debugging use `MANGO_CHATGPT_AUTH_BASE_URL` and `MANGO_CHATGPT_BASE_URL`.

## Single instance

Only one server may run at a time. On startup the server writes a state file at
`~/.mango/run/server.json`
(`{ pid, port, host, startedAt, logFile, version, buildInfo, frontendDir, service }`)
once the port is bound, and removes it on graceful shutdown. A second
`serve` / `serve -d` reads that file and refuses to start if the recorded
process is still alive. A state file whose process has died is treated as stale
and cleaned up automatically.

## Runtime files

| Path                         | Contents                                                |
| ---------------------------- | ------------------------------------------------------- |
| `~/.mango/run/server.json`   | Single-instance state file for the running server.      |
| `~/.mango/logs/server-*.log` | Output of background (`-d`) server runs.                |
| `~/.mango/logs/service.log`  | Output the service unit's supervisor appends, all runs. |

These live under `~/.mango` in both development and standalone modes so
`status`/`stop` resolve the same instance regardless of how it was launched.
Foreground `serve` logs to the terminal instead of a file.

The state file's optional `service` field carries the name of the supervisor unit
that started the process — `mangostudio.service`, `com.mangostudio.hub`, or
`MangoStudio Hub`. It is what `status`, `restart` and the machine API read to tell
a service-launched instance from a `serve -d` one, and it is absent for both
`serve` modes.

## Doctor

`mangostudio doctor` prints a plain-text checklist for home directories, config,
database, frontend, auth secret, running instance, MangoStudio runtime, how the
binary was installed (`Installed via`), and whether a newer release exists
(`Update`; see [upgrade](#upgrade)).
It also reports the running server build SHA, build date, dirty flag, current
checkout SHA, and the frontend asset SHA from `build-info.json`. If the server
SHA is behind the checkout or differs from the served frontend assets, restart
or rebuild so the API and browser bundle come from the same source revision.

When a Cursor connector is still configured (API key in env, `~/.mango/.env`, or
`[cursor_api_keys]` in `config.toml`), doctor reports a single `Cursor connector`
warning. The provider is deprecated and refuses every turn; the check exists so
an operator can see the key is still there. Use the Cursor CLI runner in the chat
runner selector instead — see [../providers/cursor.md](../providers/cursor.md).

Example (Cursor connector still present):

```text
MangoStudio doctor

[ok]   Home directory     /home/user/.mango (writable)
...
[warn] Cursor connector   Deprecated provider. Use the Cursor CLI runner in the chat runner selector; this key no longer runs turns.

1 warning(s), 0 failure(s).
```

### ChatGPT connector checks

When at least one ChatGPT connector exists (or with `--all`), doctor also runs
a ChatGPT section. OAuth connectors fail in ways API-key connectors don't —
expired or revoked refresh tokens, an unreachable OS secret store, another
process holding the fixed callback port, an unreachable backend — and each
gets its own row:

| Check             | What it verifies                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `ChatGPT secrets` | The secret store that holds the token bundles is reachable.                                      |
| `ChatGPT tokens`  | Per connector: the stored bundle is readable and parses; access-token expiry countdown.          |
| `ChatGPT refresh` | Only with `--chatgpt-refresh`: live refresh probe — reports rotation success or `invalid_grant`. |
| `ChatGPT port`    | The fixed OAuth callback port `1455` is free (Codex CLI uses the same port).                     |
| `ChatGPT auth`    | `chatgpt.auth_base_url` answers over HTTP (any status counts as reachable).                      |
| `ChatGPT backend` | `chatgpt.api_base_url` answers over HTTP (any status counts as reachable).                       |

Doctor is read-only by default: token bundles are only read, never refreshed,
and no token material is ever printed — accounts appear masked exactly like the
Settings connector card. `--chatgpt-refresh` is the one mutating exception: it
performs a real refresh, which rotates and persists the stored refresh token,
proving end-to-end that the session is still valid. An expired access token on
its own is only a warning (it refreshes on next use); a failed refresh or a
connector flagged for re-auth is a failure that means "sign in with ChatGPT
again". Network probes use the standard 5-second provider probe timeout, so
doctor never hangs offline.

### Skills checks

Doctor always runs a skills section. Skills fail quietly on the filesystem — an
unreadable directory, a frontmatter typo, a skill silently shadowed by a
higher-precedence source, one the user disabled and forgot — so each state gets
its own row:

| Check           | What it verifies                                                                             |
| --------------- | -------------------------------------------------------------------------------------------- |
| `Skills config` | The effective `skills.dir` and where it came from (`default` / `toml` / `env`).              |
| `Skills mango`  | The `~/.mango/skills` source: read health and discovered skill count.                        |
| `Skills agents` | The `~/.agents/skills` source: same, plus whether the opt-in toggle is on.                   |
| `Skills claude` | The `~/.claude/skills` source: same, plus whether the opt-in toggle is on.                   |
| `Skill <key>`   | Per skill, only when not silently active: `invalid` (fail), `shadowed` or `disabled` (note). |

Precedence is `mango` > `agents` > `claude`: on a slug collision the lower
source is reported as shadowed so a copy the user believes is active is visible.
Disabled third-party sources are still scanned and counted, but their skills
stay out of the active set.

### MCP checks

When at least one MCP server exists (or with `--all`), doctor runs an MCP
section. It is offline by default — the DB rows are read read-only and stdio
`command`s are resolved on `PATH` — and never connects unless `--probe` is
passed:

| Check                | What it verifies                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP <slug>`         | Transport and whether the server is enabled.                                                                                                    |
| `MCP <slug> command` | stdio only: the `command` is present and resolves on `PATH`, or is missing/empty (fail when enabled, warn when disabled).                       |
| `MCP <slug> probe`   | Only with `--probe`: connect + `listTools` under the 10 s budget, or a typed failure. Skipped for structurally invalid stdio rows (no command). |
| `MCP <slug> tools`   | Only with `--probe`: namespaced tool names over the provider 64-char cap are skipped.                                                           |

`--probe` connects to every enabled server, so it spawns stdio children and
reaches out to URLs; failures come back typed (`spawn ENOENT`, connection
refused, auth `401/403`, protocol mismatch, timeout). Each probe session is
force-disposed afterward so a CLI run leaves no lingering child. When a
MangoStudio server is already running, a leading `MCP probe` note flags that the
probe spawns a second stdio child per server — safe for the per-client stdio
servers MCP is designed around.

## Exit codes

- `0` — success (including idempotent `stop`/`status` when nothing is running).
- `1` — usage error (bad flag or port), refused start (already running), failed
  background start, or a `stop` that timed out (try `killserver`). `doctor`
  exits `1` if any check fails. `env install`/`env update` also use `1` for a
  run that finished in any status other than `succeeded`.
- `2` — `env install`/`env update` only: the recipe never started (blocked by
  the guard, unsupported on this platform, missing a requirement, or
  copy-only).
- `upgrade`: `0` upgraded, already current, or a `--check` preview; `1`
  refused (a package manager owns the binary and the command to run is
  printed, a source checkout, a container, an unknown origin, or an
  unsupported target); `2` the download, its verification, or the install
  script failed.

## Configuration

Host, port, and other settings follow the standard resolution order
(`process.env` → `.env` next to `config.toml` → `config.toml` → defaults). A positional
host/port on `serve` is applied as `API_HOST` / `API_PORT` before the server
reads its config. See
[`apps/api/src/lib/config.ts`](../../apps/api/src/lib/config.ts) and
[`packages/cli/README.md`](../../packages/cli/README.md) for the full environment.

If no auth secret is configured, interactive `mangostudio serve` generates a
strong `BETTER_AUTH_SECRET` and asks whether to persist it in `~/.mango/.env`
or `~/.mango/config.toml` before starting.
