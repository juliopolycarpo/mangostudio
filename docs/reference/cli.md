# CLI Reference

MangoStudio ships as a single binary that doubles as a CLI for running and
managing one local server. The same commands work from the installed binary
(`mangostudio`) and from source (`bun run apps/api/src/index.ts <command>`).

## Commands

| Command           | Description                                               |
| ----------------- | --------------------------------------------------------- |
| `mangostudio`     | Print help and the command list.                          |
| `serve [port]`    | Start the server in the foreground (default port `3001`). |
| `serve [port] -d` | Start the server in the background (detached) and return. |
| `status`          | Show whether a server is running and its details.         |
| `stop`            | Gracefully stop the running server (SIGTERM).             |
| `killserver`      | Force-kill the running server (SIGKILL).                  |
| `doctor`          | Run environment and configuration diagnostics.            |

`-d` / `--detach` and the positional port may be combined in any order, e.g.
`mangostudio serve 3000 -d`.

## Examples

```bash
mangostudio serve              # foreground on port 3001
mangostudio serve 3000         # foreground on port 3000
mangostudio serve -d           # background on the default port
mangostudio serve 3000 -d      # background on port 3000
mangostudio status
mangostudio stop
```

## How background mode works

`serve -d` re-executes the same binary with a hidden `__serve` subcommand as a
detached child process (via `Bun.spawn` with `detached` + `unref`). The parent
redirects the child's stdout/stderr to a timestamped log file, waits for the
server to report healthy, prints the PID and log path, then exits. The child
keeps running independently.

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

## Exit codes

- `0` — success (including idempotent `stop`/`status` when nothing is running).
- `1` — usage error (bad flag or port), refused start (already running), failed
  background start, or a `stop` that timed out (try `killserver`). `doctor`
  exits `1` if any check fails.

## Configuration

Port and other settings follow the standard resolution order
(`process.env` → `~/.mango/.env` → `config.toml` → defaults). A positional port
on `serve` is applied as `API_PORT` before the server reads its config. See
[`apps/api/src/lib/config.ts`](../../apps/api/src/lib/config.ts) and
[`packages/cli/README.md`](../../packages/cli/README.md) for the full environment.
