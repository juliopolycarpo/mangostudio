# Transport: local socket

A peer listens on a Unix domain socket (POSIX) or a named pipe (Windows); another peer connects
to it. Each accepted connection is one session; a listener serves many sessions at once.

## Framing

Identical to [stdio](stdio.md): NDJSON, one frame per line, `\r` stripped, blank lines ignored,
frame limit enforced per line, refused line ends the session with `4400`.

## Addresses

- POSIX: a filesystem path. Applications choose it; a runtime directory scoped to the user
  (`$XDG_RUNTIME_DIR`, `~/.mango/run/`) is the reference location. The listener creates the
  socket with owner-only permissions (`0600`). Dial observations distinguish **connected**,
  **refused** (including a path that disappeared), and **inconclusive** (timeout, permissions,
  resource exhaustion or another undecidable error). An inconclusive result MUST NOT claim
  that a live listener was observed. All occupied paths are preserved by these SDKs: a refused
  connection is not authority to unlink a pathname later. An observed socket causes
  `EADDRINUSE` / `AddrInUse` with a diagnostic that names the observation. For a non-socket
  entry or a competing publisher, TypeScript still reports `EADDRINUSE` and Rust reports
  `AlreadyExists`. Nothing at the address is overwritten or removed. Filesystems without
  no-replace socket publication fail closed.
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

## Public-path cleanup contract revision

The earlier portable stale-unlink policy is withdrawn. Neither inode/device equality nor
another stat, timestamp, sidecar convention or a final liveness probe closes the final
check/use window against an independently replaced public path. These SDKs therefore never
unlink the public POSIX address, including at listener shutdown. Close returns an explicit
`path-preserved` / `IpcCloseOutcome::PathPreserved` disposition. Applications must coordinate
exclusive cleanup outside the listener, or choose a fresh endpoint and publish its address by
an application-owned mechanism. A blind `unlink` retry is not that coordination. This stricter
lifecycle behavior requires caller migration; it does not change protocol wire version 1.

Both SDKs bind within a fresh `0700` directory on the destination filesystem and hard-link the
socket to the public name without replacement. Choose a directory where other users cannot
replace the listener's entries, such as an owner-only runtime directory or a sticky temporary
directory. Staging may move to a same-filesystem ancestor to fit the native Unix socket limit.
When no suitable location is available, publication fails closed. Both SDKs validate public
pathnames before staging or publication: TypeScript enforces the UTF-8 byte ceiling (107 on Linux, 103 on other
POSIX hosts), and Rust uses the native Unix socket address constructor. A shorter staged bind
must never make an undialable public pathname appear available. Windows named pipes are exempt
from these POSIX pathname checks. Node/libuv's automatic close unlink affects only its
private bound name, so a late close cannot delete the public successor. The private name is
absolute and uses the physical parent after symlink resolution. This keeps a relative bind's
cleanup anchored even if the process changes its working directory. Rust completes publication
and transfers ownership to the listener without a suspension point. Private staging names are
reserved for the SDK instance and must stay under its control.

## Probe and pre-handshake ownership

A successful dial probe enqueues a real transport connection on the listener. Accept callbacks,
peer credentials and transport counters are **not** authentication or application activity.
An acceptor MUST NOT grant authority, write an authenticated audit event, or start expensive
application work before the Session handshake and any application authentication complete.
The reference Session refuses pre-hello requests without invoking their handlers. Always drive
accepted ports with a Session immediately; retaining an undriven Rust port also retains its
caller-owned reservation and descriptor.

Both acceptors cap tracked connections at 64, including established sessions. They drop excess
connections and continue accepting when a slot frees up. Accepted ports enforce a 15-second
first-hello deadline independent of Session's configured handshake deadline. TypeScript closes
idle sockets directly. In Rust the deadline applies while reading or writing, including during a
blocked outbound hello before the Session starts reading. Cleanup owns the writer independently
of receive cancellation and disables sends immediately. Farewell writing and writer shutdown each
have a two-second bound. Listener shutdown also tells the local port owner to stop processing
frames. Decoding stays within the configured frame limit (16 MiB by default). An invalid or partial hello never grants
application authority. Probe EOF and Session teardown release their accepted resources.
Windows named pipes use their kernel/ACL lifecycle, return no-filesystem-path on close, and have
no POSIX public path or inode-cleanup rule. The Rust first-instance and owner DACL remain;
TypeScript applications still authenticate pipes whose Node API cannot restrict their ACL.
