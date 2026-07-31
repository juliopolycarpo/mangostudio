# Hub and Runtime Boundary

MangoStudio separates product orchestration from host-machine execution. The API is the
hub: it owns identity, chats, policy, and durable state. `apps/runtime` is an execution
host behind a versioned protocol: it owns filesystem and shell effects plus disposable
execution caches.

The runtime is embedded in the API process today, but callers use the same frame protocol
that a separate runtime process will use. This keeps transport placement out of tool
executors.

## Ownership

| Concern                                                                       | Owner                           | Notes                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Authentication, users, chats, and provider orchestration                      | Hub (`apps/api`)                | Runtime requests never carry authority that the hub has not already established.                                              |
| Tool definitions, settings, argument parsing, and workdir policy              | Hub (`apps/api`)                | The hub resolves and authorizes direct paths before invoking the runtime.                                                     |
| Recursive path filtering                                                      | Hub policy, runtime enforcement | The hub serializes allowed, denied, and containment roots; runtime glob and grep enforce them for every discovered candidate. |
| Filesystem reads, writes, patches, glob, and grep                             | Runtime (`apps/runtime`)        | The runtime owns host I/O, mutation locking, and result hashing.                                                              |
| Shell discovery, environment filtering, execution, timeout, and output bounds | Runtime (`apps/runtime`)        | The hub selects settings; the runtime applies them where the process is spawned.                                              |
| Per-chat read freshness state                                                 | Runtime (`apps/runtime`)        | This cache is disposable and can be rebuilt through normal reads.                                                             |
| Pre-mutation capture, current-state hashing, and revert effects               | Runtime (`apps/runtime`)        | Mutation responses include serializable before snapshots and resulting hashes.                                                |
| Checkpoint manifests, blobs, retention, and reverted state                    | Hub (`apps/api`)                | Durable checkpoint state remains in SQLite and hub-managed blob storage.                                                      |
| Frame schemas, compatibility, and NDJSON codec                                | Shared (`apps/shared`)          | Both sides import the same framework-agnostic contract.                                                                       |

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

| Transport                 | Status                  | Framing                                                                                      |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| Embedded in-process ports | Current                 | FIFO structured frames; development and tests round-trip every frame through the byte codec. |
| Local runtime process     | Intended next transport | Bounded NDJSON over process pipes using the same handshake and request ids.                  |
| Other runtime placements  | Future                  | Implement `RuntimeFramePort` without changing method handlers or API tool executors.         |

The shared NDJSON codec validates every frame, buffers partial lines, and rejects records
larger than 16 MiB. Production in-process delivery uses structured cloning while retaining
schema validation, so embedded execution cannot exchange values a byte transport could not
represent during development and tests.

## Extending the Boundary

Add a runtime operation as one coherent change:

1. Define its serializable parameters and result in `apps/runtime/src/methods.ts`.
2. Register a runtime handler and keep host effects inside `apps/runtime/src/services/`.
3. Expose the typed call through `apps/api/src/services/runtime-client/`.
4. Keep authorization, product policy, and durable persistence in the API.
5. Test the handler directly and test any cancellation or error translation at the API
   boundary.
