# Live Terminal

MangoStudio can open a real interactive shell on the machine an environment describes and
show it in the browser: as a **Terminal** panel in the chat's rail, or as its own browser
window from `/terminal`. Several sessions can run at once. The shell runs where the
environment's runtime runs — Local, stdio, WSL, SSH, container, or a paired machine — never
on the hub by special case.

## Where things run

| Concern                                                      | Owner                    |
| ------------------------------------------------------------ | ------------------------ |
| The PTY, the shell process, its environment and its lifetime | Runtime (`apps/runtime`) |
| Who may open a session, the registry, limits, idle reaping   | Hub (`apps/api`)         |
| Relaying bytes to the browser and flow control per socket    | Hub (`apps/api`)         |
| Session shape, socket framing, limits                        | Shared (`apps/shared`)   |
| Rendering, keystrokes, resize, acknowledgements              | Frontend (xterm.js)      |

The runtime spawns the shell with `Bun.spawn({ terminal })`, inline per spawn so the shell is a
session leader and owns its job control. There is no native addon to ship. The runtime keeps
each session's last 256 KiB of output so a viewer that comes back sees where it was.

## Protocol

Eight runtime methods carry the session — `terminal.open`, `attach`, `detach`, `write`,
`resize`, `ack`, `close`, `list` — and one event topic, `terminal.output`, streams bytes up
to the hub keyed by the hub-minted session id. Every method needs the `shell` capability; a
`readonly` machine refuses all of them, listing included. The runtime announces
`terminal: true` on its manifest and health report only when the owner granted `shell`, a
shell is present, and the build can open a PTY. Absent means unavailable.

The runtime never emits `terminal.output` before a hub has called `terminal.attach` on that
session. That invariant is what makes the topic additive: a hub too old to decode the
payload never receives it.

The browser talks to `/api/terminal/:id`, a WebSocket route of its own. `/api/ws` stays
invalidation-only. Frames are binary with a one-byte type prefix: client `data`, `resize`,
`ack`, `ping`; server `data`, `exit`, `notice`, `pong`. The codec lives in
`@mangostudio/shared/terminal`.

## Flow control

The socket options every hub WebSocket route shares close a connection at 64 KiB of
backpressure rather than throttling it, and `Bun.Terminal` cannot stop reading the PTY. So
flow control is explicit and lives in three places:

- **Browser.** After xterm.js parses a chunk, the client acknowledges the bytes. Acks are
  coalesced, not sent per frame.
- **Hub.** Acks are relayed to the runtime as `terminal.ack`. The relay keeps its own queue
  per socket, sends only while the socket's buffered amount stays under 48 KiB, resumes on
  drain, and past 1 MiB queued discards the oldest bytes and sends one `queue_overflow`
  notice.
- **Runtime.** Emission is credit-gated: at most 256 KiB may be in flight unacknowledged.
  Output beyond the window waits in a 1 MiB pending buffer; past that the oldest bytes are
  discarded and one `dropped` marker goes out when the stream resumes. The terminal draws it
  as a dim line.

A `yes` loop therefore costs bounded memory on every hop, and the socket is never closed by
the server for being fast.

## Sessions

Sessions belong to the runtime and outlive the browser socket. Closing the panel or
switching tabs detaches; attaching again replays the scrollback. One viewer holds a session
at a time: popping it out into a window takes it from the rail, which then offers to bring it
back.

A session ends when the user closes it, when it sits with no viewer for
`idle_timeout_minutes`, when the runtime connection drops, or when the hub stops. The hub's
registry is in memory; sessions do not survive a hub restart.

## Who may open one

Same capability as `shell.run`: `allow.shell` on the runtime. On the **Local** runtime — the
hub's own process and OS account — a terminal additionally requires the `single-user-host`
attestation the external-agent path already computes. A second MangoStudio user on the same
hub closes every Local terminal and refuses new ones with `TERMINAL_NOT_ISOLATED`.

The shell's environment is the runtime's own with secret-shaped variables stripped exactly as
`shell.run` strips them, plus `TERM=xterm-256color`, `COLORTERM=truecolor` and
`MANGOSTUDIO_TERMINAL=1`. The audit log records the shell, working directory and size for
`terminal.open`; keystrokes are never written.

## Configuration

```toml
[terminal]
enabled = true
idle_timeout_minutes = 30
max_sessions_per_user = 8
scrollback_kib = 256
```

Environment: `MANGO_TERMINAL_ENABLED`, `MANGO_TERMINAL_IDLE_TIMEOUT_MINUTES`,
`MANGO_TERMINAL_MAX_SESSIONS_PER_USER`, `MANGO_TERMINAL_SCROLLBACK_KIB`. With `enabled =
false` the panel is hidden and opens answer `TERMINAL_DISABLED`.

## Limits and errors

| Refusal                                     | Code                    |
| ------------------------------------------- | ----------------------- |
| Terminals switched off on the hub           | `TERMINAL_DISABLED`     |
| Per-user cap reached                        | `TERMINAL_LIMIT`        |
| Local runtime on a multi-user hub           | `TERMINAL_NOT_ISOLATED` |
| Runtime offers no PTY, or the owner refused | `UNSUPPORTED`           |

`GET /api/terminals/availability?environmentId=…` answers all of these before anyone types,
so the panel can explain rather than fail on open. Container environments need a shell in
the image; the panel says so.

## Windows

Sessions on a Windows runtime use ConPTY through Bun with PowerShell (`pwsh` preferred,
`powershell.exe` fallback). Resize works. Known gaps carried from Bun's ConPTY support: no
`SIGWINCH` in children, output is re-encoded, and `close()` can block on Windows builds
older than 11 24H2 while a child is still running — the runtime kills the process tree
first. This repository has no Windows unit-test lane, so the PowerShell branch ships by code
reading; the POSIX path is covered by real-PTY tests.
