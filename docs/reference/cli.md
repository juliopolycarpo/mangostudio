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
| `doctor --all`                     | Include Cursor runtime checks even without a Cursor connector.                      |
| `doctor --cursor-probe`            | After chain checks pass, spawn the sidecar `validate_api_key` RPC with a dummy key. |
| `version`, `--version`, `-v`       | Print the embedded MangoStudio version.                                             |

`-d` / `--detach` and the positional host/port target may be combined in any
order, e.g. `mangostudio serve 127.0.0.1:3000 -d`.

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

## Single instance

Only one server may run at a time. On startup the server writes a state file at
`~/.mango/run/server.json` (`{ pid, port, host, startedAt, logFile, version }`)
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
