# Hub and Runtime Boundary

MangoStudio separates product orchestration from host-machine execution. The API is the
hub: it owns identity, chats, policy, and durable state. `apps/runtime` is an execution
host behind a versioned protocol: it owns filesystem and shell effects plus disposable
execution caches.

The runtime is embedded in the API process today, but callers use the same frame protocol
that a separate runtime process will use. This keeps transport placement out of tool
executors.

## Ownership

| Concern                                                                       | Owner                           | Notes                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication, users, chats, and provider orchestration                      | Hub (`apps/api`)                | Runtime requests never carry authority that the hub has not already established.                                                                                                                |
| Tool definitions, settings, argument parsing, and workdir policy              | Hub (`apps/api`)                | The hub decides whether tools are restricted to a chat workdir; path resolution happens before runtime invocation, in the target's path style.                                                  |
| Workspace browse and validate (`workspace.browse`, `workspace.validate`)      | Runtime (`apps/runtime`)        | Directory listing and workdir existence checks; hub routes are thin RuntimeClient facades.                                                                                                      |
| Path containment algorithm                                                    | Runtime (`apps/runtime`)        | Shared `isPathPrefix` / ancestor resolution / `assertInsideWorkdir`; hub keeps the workdir-policy decision.                                                                                     |
| Path policy on filesystem calls                                               | Hub policy, runtime enforcement | The hub serializes allowed, denied, and containment roots as `pathPolicy`; the runtime enforces them link-resolved on every filesystem method, including the candidates glob and grep discover. |
| Filesystem reads, writes, patches, glob, and grep                             | Runtime (`apps/runtime`)        | The runtime owns host I/O, mutation locking, and result hashing.                                                                                                                                |
| Shell discovery, environment filtering, execution, timeout, and output bounds | Runtime (`apps/runtime`)        | The hub selects settings; the runtime applies them where the process is spawned.                                                                                                                |
| Git CLI execution (`git.exec`, argv-array-only)                               | Runtime (`apps/runtime`)        | Hardened spawn, env whitelist, timeout, and output bounds; the hub keeps parsers, locks, and routes.                                                                                            |
| Per-chat read freshness state                                                 | Runtime (`apps/runtime`)        | This cache is disposable and can be rebuilt through normal reads.                                                                                                                               |
| Pre-mutation capture, current-state hashing, and revert effects               | Runtime (`apps/runtime`)        | Mutation responses include serializable before snapshots and resulting hashes. Optional `containmentRoot` on revert.                                                                            |
| Checkpoint manifests, blobs, retention, and reverted state                    | Hub (`apps/api`)                | Durable checkpoint state remains in SQLite and hub-managed blob storage.                                                                                                                        |
| Frame schemas, compatibility, and NDJSON codec                                | Shared (`apps/shared`)          | Both sides import the same framework-agnostic contract.                                                                                                                                         |

The runtime must not import API modules or persist product state. The hub must not bypass
the runtime client for execution that belongs to the runtime.

## Protocol

Connection setup is runtime-led:

```text
Runtime                                      Hub
  |-- hello(protocol, version, manifest) ----->|
  |<----------- hello_ack(protocol, version) --|
  |                                             |
  |<------------ req(id, method, params) -------|
  |------------- res(id, ok | err) ------------>|
  |                                             |
  |<---------------- cancel(id) ----------------|
```

The `hello` manifest reports platform, architecture, path style, home directory, available
shells, Git availability, and feature flags. Requests are accepted only after the handshake.
Hub and runtime must agree on the protocol major/minor pair; patch-only protocol revisions
remain compatible.

Every request has a unique id and exactly one success or typed error response. Cancellation
travels as a `cancel` frame and aborts the runtime handler's local `AbortSignal`; an
`AbortSignal` is never serialized in request parameters. Event and ping/pong frames are also
part of the transport-neutral envelope for future streaming and liveness needs.

Protocol errors use stable codes such as `RUNTIME_UNAVAILABLE`, `METHOD_UNSUPPORTED`,
`PROTOCOL_MISMATCH`, `CANCELLED`, and `TIMEOUT`. Runtime service failures add a typed
`details.kind`; the API facade translates those details back into its existing tool and
checkpoint errors.

## Transports

| Transport                 | Status  | Framing                                                                                      |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| Embedded in-process ports | Current | FIFO structured frames; development and tests round-trip every frame through the byte codec. |
| Local runtime process     | Current | Bounded NDJSON over the child's pipes, using the same handshake and request ids.             |
| Other runtime placements  | Future  | Implement `RuntimeFramePort` without changing method handlers or API tool executors.         |

The shared NDJSON codec validates every frame, buffers partial lines, and rejects records
larger than 16 MiB. Production in-process delivery uses structured cloning while retaining
schema validation, so embedded execution cannot exchange values a byte transport could not
represent during development and tests.

## Stdio Transport

`mangostudio-runtime` is a second binary built from `apps/runtime/src/cli.ts` and shipped in
every distribution channel beside the hub binary. `mangostudio-runtime --stdio` serves the
protocol over the child's own pipes.

**stdout is the protocol stream.** Nothing else may write to it, which is why the stdio mode
routes the stdout console methods to stderr. The hub keeps a bounded tail of the child's
stderr and folds it into the message a failed connect reports.

An environment with `transportKind: 'stdio'` carries `{ binaryPath?, cwd? }`. `binaryPath`
defaults to the sibling binary resolved from the hub's own executable — a source checkout runs
the workspace entry under Bun instead — and exists as an override for development. argv is
assembled from discrete arguments, never a command string to interpolate, and the child's
environment is sanitized like any other spawned process so connector keys and the auth secret
do not reach it.

`spawnRuntimeChild` takes an already-resolved command rather than a transport config, so a
launcher that reaches its target through a wrapper — a WSL distro, an SSH host — supplies its
own argv and reuses the spawn, handshake, and teardown path unchanged.

Lifecycle:

- **Connect** spawns the child and waits up to five seconds for its `hello`. A missing binary,
  a non-executable one, and a protocol mismatch each produce their own actionable message.
- **Loss** (crash, killed process, broken pipe) fails every in-flight request with
  `RUNTIME_UNAVAILABLE` and moves the environment to `disconnected` rather than `error`: the
  target is usually still there, only the process is gone.
- **Reconnection is a deadline, not a timer.** Nothing is scheduled; the next caller that needs
  the runtime pays for the retry, and while inside the exponential backoff window (1s, 2s, 4s,
  8s) the attempt fails fast. Five consecutive failures — or any protocol mismatch, which
  cannot fix itself — latch the environment until someone connects it explicitly. A disabled,
  deleted, or simply unused environment therefore never respawns on its own.
- **A handshake is not proof of health.** A connection that dies within ten seconds keeps
  counting toward that cap instead of clearing it, so a runtime that crashes on startup latches
  like any other failure rather than being respawned once per caller forever. Enabling an
  environment again clears whatever the count reached while it was off.
- **Shutdown** closes every connection and waits for the children to exit — bounded, so one
  that ignores both signals delays the hub rather than holding it open — so none are orphaned.

Known gap: Windows has no POSIX signals, so killing a runtime there terminates the runtime
itself but not shell children it already spawned. The runtime's own cancellation path reaps
those in the normal case; a hard kill can still leave them.

The hub and the runtime ship from one release. The handshake refuses a major/minor protocol
mismatch, and for stdio it also refuses a runtime whose release version differs from the hub's
— the protocol version only moves when the wire format does, so it cannot catch a binary an
older install left behind. `mango doctor` reports whether the sibling binary is present and
whether its version matches. It reports a warning rather than a failure: a hub without it still serves
chats through the embedded Local runtime, it just cannot start stdio environments.

## Paths Across Hosts

An environment need not run the operating system the hub runs on, and there is no path
translation layer: a path inside a WSL distro is a native Linux path from end to end, and
nothing rewrites it on the way. What the hub does instead is *resolve* in the target's
terms.

Tools take absolute paths, `~` paths, and paths relative to the chat working directory, and
the hub turns those into one absolute path before it calls. Both inputs to that are facts
about the target, and both arrive in the `hello` manifest:

- `homeDir` expands `~`. The hub's own `HOME` describes the wrong machine, and on Windows it
  is usually not set at all.
- `pathStyle` selects the separator and the notion of absoluteness used to join and fold the
  result. Resolution is purely lexical and never consults the hub's working directory, which
  is a directory the target need not have.

`RuntimeClient.paths` exposes both, read from the connection that will receive the call, so
one environment's manifest cannot be paired with another's connection.

Policy is decided the same way and enforced somewhere else. The hub checks allowed roots,
denied roots, and workdir containment lexically, then sends the same roots along as
`pathPolicy`; the runtime re-checks the call's paths after following symlinks, because a
link inside the working directory that points out of it exists on the target's disk and is
invisible from the hub. A call with nothing configured and no restriction carries no policy.

## Extending the Boundary

Add a runtime operation as one coherent change:

1. Define its serializable parameters and result in `apps/runtime/src/methods.ts`.
2. Register a runtime handler and keep host effects inside `apps/runtime/src/services/`.
3. Expose the typed call through `apps/api/src/services/runtime-client/`.
4. Keep authorization, product policy, and durable persistence in the API.
5. Test the handler directly and test any cancellation or error translation at the API
   boundary.
