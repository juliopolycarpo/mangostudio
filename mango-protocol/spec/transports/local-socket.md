# Transport: local socket

A peer listens on a Unix domain socket (POSIX) or a named pipe (Windows); another peer connects
to it. Each accepted connection is one session; a listener serves many sessions at once.

## Framing

Identical to [stdio](stdio.md): NDJSON, one frame per line, `\r` stripped, blank lines ignored,
frame limit enforced per line, refused line ends the session with `4400`.

## Addresses

- POSIX: a filesystem path. Applications choose it; a runtime directory scoped to the user
  (`$XDG_RUNTIME_DIR`, `~/.mango/run/`) is the reference location. The listener creates the
  socket with owner-only permissions (`0600`). A socket file at the address is *stale* when a
  connection to it is refused: the listener removes a stale file before binding, and refuses to
  bind — the address is in use — when a connection to it succeeds or cannot be judged. Anything
  at the address that is not a socket is never removed.
- Windows: `\\.\pipe\<name>`, spelled with backslashes. Forward slashes are not equivalent.
  The listener creates the pipe in byte mode. A named pipe admits every local user unless the
  listener attaches a security descriptor, so a listener SHOULD create the pipe with a DACL
  admitting only the pipe's owner.

A listener that publishes its address must not be connectable by a stranger for even one
instant, and neither platform lets the address and its permissions be created in one step. A
listener therefore SHOULD create the endpoint somewhere only it can reach and publish it at the
final address afterwards: on POSIX, bind inside a directory created `0700` and hard-link the
socket out to the address, so traversal denial — not the socket's own mode, which `bind` takes
from the umask — is what refuses a stranger in the window before `chmod`; on Windows, attach the
descriptor in the `CreateNamedPipe` call that creates the pipe, which has no such window.

## Authentication

Same-machine trust is the floor, not the credential. Reading the credentials the operating
system offers — the pipe client's token, `SO_PEERCRED`, `getpeereid` — is the reference check on
both platforms, and an SDK that exposes peer credentials at all SHOULD expose them to the
listener before the first frame.

A listener that cannot restrict its address to the owner — a POSIX path on a filesystem that
ignores permissions, a Windows pipe created without a descriptor — MUST authenticate the peer
before it serves any request: peer credentials, or an application credential carried in
`hello.capabilities`. A peer that fails the check is refused with `close` `4401` and, per
[§5.1](../mango-protocol-1.md#51-hello), before this side sends its own `hello`. Where the
address is already owner-only, that check is a MAY.

## Liveness

Protocol `ping`/`pong` both ways on a fixed cadence, as for stdio.

## Close

`close` then socket shutdown. A connection that ends without a `close` frame is a `4000`
release. A listener shutting down sends `close` `4000` to every session it still owns first. A
listener that hands each accepted port to its caller no longer owns those sessions; it SHOULD
keep a weak handle per accepted connection so it can still send that farewell, and a session
whose owner dropped it simply ends as a `4000` release when the socket does.

## Notes

- One session per connection. A client that needs two sessions opens two connections.
- A listener that is superseded by another process at the same path is an application concern:
  the protocol only says the old sessions end with `4409` if the listener chooses to say so.
