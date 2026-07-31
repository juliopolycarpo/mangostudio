# CLI Reference

MangoStudio ships as a single binary that doubles as a CLI for running and
managing one local server. The same commands work from the installed binary
(`mangostudio`) and from source (`bun run apps/api/src/index.ts <command>`).

## Install channels

Pick any distribution channel — each ships the same prebuilt binary and frontend
sidecar. See the [README install matrix](../../README.md#install) for
copy-paste commands, or:

| Channel            | Entry point                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| npm / bun          | `mangostudio` — see [`packages/cli/README.md`](../../packages/cli/README.md)                                     |
| Homebrew           | `brew install juliopolycarpo/tap/mangostudio`                                                                    |
| Shell / PowerShell | `install.sh` / `install.ps1` from [mangostudio.dev](https://mangostudio.dev)                                     |
| Scoop              | `juliopolycarpo/scoop-bucket` → `scoop install mangostudio`                                                      |
| Cargo              | `cargo install mangostudio` — see [`packages/cargo-shim/README.md`](../../packages/cargo-shim/README.md)         |
| Docker             | `ghcr.io/juliopolycarpo/mangostudio` — see [`docs/operations/deployment.md`](../operations/deployment.md#docker) |
| Manual             | Download platform archives from GitHub Releases and verify `SHA256SUMS`                                          |

## Commands

| Command                            | Description                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `mangostudio`                      | Print help and the command list.                                                    |
| `serve [host\|port\|host:port]`    | Start the server in the foreground (default `localhost:3001`).                      |
| `serve [host\|port\|host:port] -d` | Start the server in the background (detached) and return.                           |
| `status`                           | Show whether a server is running and its details.                                   |
| `stop`                             | Gracefully stop the running server (SIGTERM).                                       |
| `killserver`                       | Force-kill the running server (SIGKILL).                                            |
| `doctor`                           | Run environment and configuration diagnostics.                                      |
| `doctor --all`                     | Include Cursor and ChatGPT connector checks even without a configured connector.    |
| `doctor --cursor-probe`            | After chain checks pass, spawn the sidecar `validate_api_key` RPC with a dummy key. |
| `doctor --chatgpt-refresh`         | Perform a live ChatGPT token refresh probe (rotates the stored refresh token).      |
| `doctor --probe`                   | Actively connect to each enabled MCP server (spawns children / hits URLs).          |
| `doctor --env` / `--library`       | Limit extra sections to environments and/or library (core checks always run).       |
| `doctor --json`                    | Emit structured JSON (checks, warning/failure counts).                              |
| `env [runtimes\|agents] [--json]`  | Report runtimes, version managers, and agent CLIs (read-only).                      |
| `library [locations] [--json]`     | Library coverage matrix and location health (read-only).                            |
| `library --kind <kind>`            | Filter resources by kind (`skill`, `subagent`, etc.).                               |
| `library --divergent`              | List only resources whose copies disagree across locations.                         |
| `version`, `--version`, `-v`       | Print the embedded MangoStudio version.                                             |

`-d` / `--detach` and the positional host/port target may be combined in any
order, e.g. `mangostudio serve 127.0.0.1:3000 -d`.

## `mangostudio-runtime`

Every channel installs a second binary beside `mangostudio`. It is the execution
host for environments configured to run out of process: MangoStudio spawns it and
speaks its protocol over the child's pipes. It is not meant to be run by hand, and
it must stay in the same directory as the main binary — that is how MangoStudio
finds it.

| Command                       | Description                                                   |
| ----------------------------- | ------------------------------------------------------------- |
| `mangostudio-runtime --stdio` | Serve the runtime protocol over stdin/stdout (NDJSON frames). |
| `mangostudio-runtime --help`  | Print usage. Bare invocation does the same.                   |
| `--version`, `-v`             | Print the runtime version, which matches the MangoStudio one. |

`stdio` also works as a bare word for each mode (`mangostudio-runtime stdio`).

In `--stdio` mode stdout carries protocol frames and nothing else; every diagnostic
goes to stderr, which MangoStudio collects into its own logs. `mangostudio doctor`
reports whether this binary is present and whether its version matches the hub's —
a mismatch is refused at the protocol handshake, so reinstall rather than mixing
releases.

Host aliases: `lan`, `all`, `any`, and `public` bind `0.0.0.0`; `local` binds
`127.0.0.1`.

## Examples

```bash
mangostudio serve              # foreground on localhost:3001
mangostudio serve 3000         # foreground on localhost:3000
mangostudio serve 127.0.0.1 -d # background on 127.0.0.1:3001
mangostudio serve lan:3000 -d  # background on 0.0.0.0:3000
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
(`{ pid, port, host, startedAt, logFile, version, buildInfo, frontendDir }`)
once the port is bound, and removes it on graceful shutdown. A second
`serve` / `serve -d` reads that file and refuses to start if the recorded
process is still alive. A state file whose process has died is treated as stale
and cleaned up automatically.

## Runtime files

| Path                         | Contents                                           |
| ---------------------------- | -------------------------------------------------- |
| `~/.mango/run/server.json`   | Single-instance state file for the running server. |
| `~/.mango/logs/server-*.log` | Output of background (`-d`) server runs.           |

These live under `~/.mango` in both development and standalone modes so
`status`/`stop` resolve the same instance regardless of how it was launched.
Foreground `serve` logs to the terminal instead of a file.

## Doctor

`mangostudio doctor` prints a plain-text checklist for home directories, config,
database, frontend, auth secret, running instance, and MangoStudio runtime.
It also reports the running server build SHA, build date, dirty flag, current
checkout SHA, and the frontend asset SHA from `build-info.json`. If the server
SHA is behind the checkout or differs from the served frontend assets, restart
or rebuild so the API and browser bundle come from the same source revision.

When a Cursor connector is configured (API key in env, `~/.mango/.env`, or
`[cursor_api_keys]` in `config.toml`), doctor also reports each link in the
Cursor runtime chain:

| Check            | What it verifies                                            |
| ---------------- | ----------------------------------------------------------- |
| `Cursor Node`    | Host Node.js `>= 22.13` (`node` path and version)           |
| `Cursor sidecar` | `cursor-sidecar/run-agent.mjs` beside the binary            |
| `Cursor SDK`     | Vendored `@cursor/sdk` package with cjs/esm chunks          |
| `Cursor native`  | Platform-native `@cursor/sdk-*` package in the sidecar tree |

Pass `--all` to run the Cursor section even when no Cursor connector is
configured. Pass `--cursor-probe` to spawn the sidecar after the chain checks
pass; an auth rejection for the probe key means the Node → sidecar → SDK path
is healthy.

Example (Cursor configured, healthy chain):

```text
MangoStudio doctor

[ok]   Home directory     /home/user/.mango (writable)
...
[ok]   Cursor Node        /usr/bin/node (v22.13.0, meets >= 22.13)
[ok]   Cursor sidecar     /opt/mangostudio/cursor-sidecar/run-agent.mjs (present)
[ok]   Cursor SDK         .../node_modules/@cursor/sdk/package.json (cjs/esm chunks complete)
[ok]   Cursor native      @cursor/sdk-linux-x64 (present)

0 warning(s), 0 failure(s).
```

See [`docs/providers/cursor.md`](../providers/cursor.md#troubleshooting) for
reason-code meanings and remediation.

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
  exits `1` if any check fails.

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
