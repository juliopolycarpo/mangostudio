# Hub and Runtime Boundary

MangoStudio separates product orchestration from host-machine execution. The API is the
hub: it owns identity, chats, policy, and durable state. `apps/runtime` is an execution
host behind a versioned protocol: it owns filesystem and shell effects plus disposable
execution caches.

The Local runtime runs inside the API process, and even there a call crosses a real port
pair and the same session, handlers and error mapping a runtime on another machine is reached
through. This keeps transport placement out of tool executors.

## Ownership

| Concern                                                                          | Owner                           | Notes                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication, users, chats, and provider orchestration                         | Hub (`apps/api`)                | Runtime requests never carry authority that the hub has not already established.                                                                                                                                                                                        |
| Tool definitions, settings, argument parsing, and workdir policy                 | Hub (`apps/api`)                | The hub decides whether tools are restricted to a chat workdir; path resolution happens before runtime invocation, in the target's path style.                                                                                                                          |
| Workspace browse and validate (`workspace.browse`, `workspace.validate`)         | Runtime (`apps/runtime`)        | Directory listing and workdir existence checks; hub routes are thin RuntimeClient facades.                                                                                                                                                                              |
| Lexical path resolution and containment                                          | Hub (`apps/api`)                | `TargetPaths` resolves `~` and relative input in the target's style, then checks allowed, denied, and containment roots as string prefixes. Decides; never the last word.                                                                                               |
| Link-resolved path containment                                                   | Runtime (`apps/runtime`)        | Shared `isPathPrefix` / ancestor resolution / `assertInsideWorkdir`. Only the host holding the filesystem can see that a name inside a root is a symlink out of it.                                                                                                     |
| Path policy on filesystem calls                                                  | Hub policy, runtime enforcement | The hub serializes allowed, denied, and containment roots as `pathPolicy`; the runtime enforces them link-resolved on every filesystem method, including the candidates glob and grep discover.                                                                         |
| Filesystem reads, writes, patches, glob, and grep                                | Runtime (`apps/runtime`)        | The runtime owns host I/O, mutation locking, and result hashing.                                                                                                                                                                                                        |
| Shell discovery, environment filtering, execution, timeout, and output bounds    | Runtime (`apps/runtime`)        | The hub selects settings; the runtime applies them where the process is spawned.                                                                                                                                                                                        |
| Git CLI execution (`git.exec`, argv-array-only)                                  | Runtime (`apps/runtime`)        | Hardened spawn, env whitelist, timeout, and output bounds; the hub keeps parsers, locks, and routes.                                                                                                                                                                    |
| Per-chat read freshness state                                                    | Runtime (`apps/runtime`)        | This cache is disposable and can be rebuilt through normal reads.                                                                                                                                                                                                       |
| Pre-mutation capture, current-state hashing, and revert effects                  | Runtime (`apps/runtime`)        | Mutation responses include serializable before snapshots and resulting hashes. Optional `containmentRoot` on revert.                                                                                                                                                    |
| Checkpoint manifests, blobs, retention, and reverted state                       | Hub (`apps/api`)                | Durable checkpoint state remains in SQLite and hub-managed blob storage.                                                                                                                                                                                                |
| MCP sessions: the SDK, the child process, the outbound HTTP request              | Runtime (`apps/runtime`)        | A server row names an environment; its session opens there. Only `apps/runtime/src/services/mcp/**` may import `@modelcontextprotocol/sdk`.                                                                                                                             |
| MCP server rows, secrets, tool naming, and the pending elicitation registry      | Hub (`apps/api`)                | The wire names a model sees must not change with placement; secrets live in one store and are delivered at connect. See [mcp.md](../reference/mcp.md).                                                                                                                  |
| Toolchain, version-manager, and agent-CLI detection (`probing.*`)                | Runtime (`apps/runtime`)        | PATH scans, version spawns, auth-signal stats, and library location stats all describe the machine they run on. Per-scan budgets live with the spawns they bound.                                                                                                       |
| Detection policy: recipes, Node release data, cache freshness                    | Hub (`apps/api`)                | Installability, live LTS metadata, and how long an answer may be reused are hub decisions and travel down as parameters. Cache keys include the connection, so a reconnect drops what it said.                                                                          |
| Spawn environment: the toolchain `PATH` prefix every spawned process starts with | Runtime (`apps/runtime`)        | `spawn-env.ts` resolves the selection the hub sends (`auto` or one probed installation) once per spawn; `shell.run`, `install.run`, `terminal.open` and `external-agent.open` apply their own secret policy on top. See [environments.md](../features/environments.md). |
| Toolchain selection storage and validation                                       | Hub (`apps/api`)                | `environment_toolchains` keyed by user and environment (`local` is a sentinel); a path is accepted only when the environment's probe reported it.                                                                                                                       |
| Install execution (`install.run`, `install.cancel`)                              | Runtime (`apps/runtime`)        | The argv arrives already built from a code-defined recipe; output streams back on `install.output`. See [environment-installs.md](environment-installs.md).                                                                                                             |
| Install recipes, guards, audit rows, and the SSE stream                          | Hub (`apps/api`)                | Whether a recipe may run — including the per-environment `allowInstalls` opt-in — and the system of record for what ran.                                                                                                                                                |
| Interactive terminal sessions (`terminal.*`)                                     | Runtime (`apps/runtime`)        | The PTY, the shell, its env and its lifetime; output streams back on `terminal.output` under an ack window. See [terminal.md](../features/terminal.md).                                                                                                                 |
| Terminal registry, limits, Local isolation gate, and the browser socket relay    | Hub (`apps/api`)                | Who may open one, how many, for how long idle; `/api/terminal/:id` relays bytes with its own flow control because `/api/ws` is invalidation-only.                                                                                                                       |
| Runtime contract: methods, capabilities, events, manifest, error vocabulary      | Shared (`apps/shared`)          | `apps/shared/src/runtime-contract/` defines it once; the hub's typed client and the runtime's handler map are both derived from that definition.                                                                                                                        |
| Wire framing, negotiation, close codes, and liveness                             | `@mangostudio/protocol`         | The SDK owns the envelope and the transports. Both workspaces import it and neither restates it.                                                                                                                                                                        |

The runtime must not import API modules or persist product state. The hub must not bypass
the runtime client for execution that belongs to the runtime.

## Protocol

Connection setup is symmetric. Both peers send one `hello` as soon as the transport opens,
neither waits for the other's, and there is no acknowledgement frame:

```text
Runtime                                            Hub
  |--- hello(peer, capabilities: manifest) -------->|
  |<-- hello(peer, capabilities: contracts, hub) ---|
  |                                                 |
  |<------------ req(id, method, params) -----------|
  |------------- res(id, result) | err(id, error) ->|
  |                                                 |
  |<------------------ cancel(id) ------------------|
  |------------ evt(topic, seq, payload) ---------->|
```

The runtime's `hello.capabilities` **is** the manifest: platform, architecture, path style,
home directory, available shells, Git and `gh` availability, feature flags, and the vendor
adapters it carries — plus a `contracts` entry naming `mangostudio.runtime` and the contract
version. The hub's carries the same `contracts` entry and, unless the connector passed one of
its own, `hub: { host, user }`: who is asking, for the runtime's audit log. The protocol
defines no member of `capabilities`, so deciding that what came back is a runtime manifest
and not merely something that speaks the wire is the hub's own job, in `openHubSession`
(`apps/api/src/services/runtime-client/hub-session.ts`).

Everything under the manifest belongs to the SDK, and the
[wire specification](https://github.com/juliopolycarpo/mango-protocol/blob/main/spec/mango-protocol-1.md)
is where it is written down rather than restated here: negotiation (§5.2 — the majors must
match, and the effective minor is the lower of the two), requests and responses (§6),
cancellation (§7), events and streams with their per-stream `seq` (§8), liveness (§9), close
codes (§10), and frame limits (§11).

The error vocabulary is the ten codes the protocol reserves (§6.3) plus this application's
own — `RUNTIME_UPDATE_REFUSED` today — in `apps/shared/src/runtime-contract/errors.ts`. A
consent refusal is `DENIED` with `details.kind = "consent_denied"`. Runtime service failures
add a typed `details.kind` of their own; the API facade translates those details back into
its existing tool and checkpoint errors.

### What a cancelled call is allowed to do

Every handler receives the call's `AbortSignal`, and the rule they all follow is the same:

> **A runtime method may refuse before it mutates, and must not abandon a mutation in
> progress.**

Cancelling is a hub decision about a result nobody wants any more, not a licence to leave the
target machine in a state nobody asked for. A write stopped between its temporary file and the
rename, or a revert stopped halfway down its operation list, produces exactly that: a
filesystem no checkpoint describes and no retry can resume from.

So the useful cancellation points are the ones with nothing to undo — on entry, inside the
path lock before the first write, and inside the loops that only read: walking a directory in
`fs.glob` and `fs.grep`, hashing the expected set in `snapshot.revert`. Once bytes start
moving, the call finishes and reports what it did. `services/cancellation.ts` holds the one
refusal every service raises; it carries the `AbortError` name the SDK session maps to
`CANCELLED`, so a cancelled call is never reported as a failed one. The mapping reads that
thrown name, not the signal being aborted: a mutation that failed after it had already begun
still reports as that failure, including any paths already changed.

Long-running calls are bounded on their own terms rather than left for a cancel to rescue: a
shell command kills its process group and stops reading the pipes at its timeout, and `fs.grep`
gives each file a wall-clock budget in a worker thread, because a regular expression the model
supplied can hold the event loop and no signal can interrupt one.

### Protocol evolution

The contract grows without moving the wire under it — `RUNTIME_CONTRACT_VERSION` is
independent of the protocol version, and neither has to move for an additive method:

- **Tolerant manifest.** Feature keys beyond the original six are optional. An absent value
  means the peer predates the key and should be treated as granted (`true`) so an older
  runtime is not silently stripped of tools the hub already trusted. Top-level keys that
  describe what the peer's *build* can do read the other way — `enforcesPathPolicy` and
  `publishesWindowsSlot` are false when absent, because assuming a capability nobody
  claimed is what they exist to prevent. Those arrive only on `hello`, so a
  `runtime.health` refresh carries them forward rather than recomputing them.
- **Open `err.code`.** The SDK preserves an error code it has never heard of rather than
  refusing the frame, because an unknown code is a refusal from a newer peer and not a
  protocol violation. The hub narrows what it reads with `narrowRuntimeErrorCode`
  (`apps/shared/src/runtime-contract/errors.ts`), which maps anything outside this build's
  union to `INTERNAL`. Known codes stay typed.
- **Hello features from consent.** The runtime derives advertised features from the slot
  allow set intersected with what is present (shells, git), and may include an optional
  `profile` field and the pre-intersection `allow` set. `features` alone cannot separate
  "the owner refused this" from "the machine does not have it" — `git` is false either way
  — so a surface that reports refusals reads `allow` and treats its absence (an older peer)
  as "cannot tell", never as a refusal.
  `externalAgents` is the deliberate exception: spawning a vendor CLI is newly privileged, so an
  older stored allow set that lacks this key normalizes it to `false`. Adapter availability is a
  separate optional top-level manifest list, and absence there means the runtime has no adapter.
- **Refreshing the cached manifest.** `runtime.health` exposes the same report mid-session.
  Consent is answered on the machine, so the hub has nothing to invalidate on: reading an
  environment re-asks in the background when the cached manifest is older than the
  freshness window, and publishes an invalidation only when the answer actually moved.
  Without it the card shows the profile the runtime had at connect until someone
  reconnects. An unreadable config answers `none` here for the same reason the dispatch
  gate does — the report is what the hub caches, so it must not advertise what every call
  will refuse.
- **A new event topic is safe only if the peer asks for it first.** `evt` topics are a free
  string, so adding one never fails a decode — but an older hub that cannot read the payload
  would still receive the frames. `terminal.output` holds the invariant that makes this
  additive: the runtime never emits on it before a hub has called `terminal.attach`, so a hub
  that does not know the method never sees the topic. A future streaming topic owes the same
  handshake.

A runtime built on the previous wire (`1.0.1`) is refused rather than half-understood. Its
`hello` fails this decoder's schema, which §5.2 treats exactly as it treats a differing
major, so the port closes with `4426` — over the paired socket and over stdio alike. Dialling
in, the environment reads `disconnected` rather than failed
(`apps/api/tests/integration/routes/runtime-socket.integration.test.ts`); spawned, the child
is terminated with the launch it failed (`apps/runtime/tests/unit/cli.test.ts`). Both run
against the frozen bytes in `legacy-hello-1-0-1.ts`. `4426` is in the old binary's own fatal
set, so it stops rather than redialling and prints the message that names updating it.

The other direction has no such handshake, and is worth stating plainly: a `1.0.1` hub
dialling a Direct URL runtime on this wire waits for a greeting in a framing this runtime no
longer writes, and its decoder refuses the one it gets. The attempt ends in that hub's own
handshake timeout and whatever its retry policy does with one — no close code names the
cause, because the peer that could name it is the one that cannot read the frame. Updating
the hub is the fix.

## Transports

| Transport                 | Status  | Direction        | Framing                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedded in-process ports | Current | —                | [In-process](https://github.com/juliopolycarpo/mango-protocol/blob/main/spec/transports/in-process.md): a real port pair. Production clones and schema-checks each frame; development and tests round-trip it through the byte codec (`validateInProcessFrames`), so a value a byte transport could not carry fails here first. |
| Local runtime process     | Current | Hub spawns       | [Spawn](https://github.com/juliopolycarpo/mango-protocol/blob/main/spec/transports/spawn.md) over [stdio](https://github.com/juliopolycarpo/mango-protocol/blob/main/spec/transports/stdio.md): NDJSON on the child's own pipes.                                                                                                |
| WSL distribution          | Current | Hub spawns       | The stdio transport, launched through `wsl.exe`. A launcher, not a framing of its own.                                                                                                                                                                                                                                          |
| Paired WebSocket          | Current | Runtime dials in | [WebSocket](https://github.com/juliopolycarpo/mango-protocol/blob/main/spec/transports/websocket.md): chunked binary messages under `mango.v1`, to `/api/runtime`, authenticated by a pairing token.                                                                                                                            |
| Direct URL                | Current | Hub dials out    | The same WebSocket transport; the runtime listens and the hub presents a serve token.                                                                                                                                                                                                                                           |
| SSH                       | Current | Hub spawns       | A launcher over stdio: the SDK's hardened `ssh` preset, with the runtime on the far end of its pipe.                                                                                                                                                                                                                            |
| Container                 | Current | Hub spawns       | A launcher over stdio: `docker`/`podman` run, with the runtime bind-mounted into the image.                                                                                                                                                                                                                                     |

Which one to reach for:

- **This machine** — Local, or a local process for an isolated one.
- **A Linux distribution on this Windows machine** — WSL.
- **A machine somewhere else, especially behind NAT or a firewall** — a paired WebSocket.
  It needs no inbound port on the target and no route from the hub to it; it needs the
  target to be able to reach the hub, and the hub to know its own public address.
- **A machine the hub can already reach by URL** — Direct URL. The runtime listens
  (`mangostudio-runtime serve`); the hub dials it. Prefer this on a LAN, or when TLS
  terminates in front of the runtime. Prefer paired WebSocket when the target cannot accept
  inbound connections.
- **A machine you already reach with `ssh`** — SSH. It reuses the keys, agent, `~/.ssh/config`
  and `known_hosts` that are already set up, needs nothing on the hub beyond an ssh client, and
  needs no credential of MangoStudio's own. Nothing needs to be installed first: the
  environment card can push the runtime binary and run `setup` over the same ssh channel.
- **This machine, but the agent must not reach the rest of it** — Container. Tools run inside a
  disposable container started from an image you already have. This is the one transport whose
  purpose is what the agent *cannot* do, rather than where it runs.

## The Runtime Home

Every runtime keeps its state in one place on the machine it runs on:

```text
~/.mango/runtime/
├── host/                          # the runtime this machine's own install ships
│   └── runtime.json               # no bytes: the binary sits beside the hub
├── wsl/                           # placed by a Windows hub, inside the distribution
│   ├── runtime.json
│   ├── current -> 0.1.1           # the symlink an upgrade swaps
│   └── 0.1.1/mangostudio-runtime
└── remote/                        # placed over ssh, or installed for ws / Direct URL
    ├── runtime.json
    ├── credentials.json           # 0600; pairing and serve tokens only
    ├── current -> 0.1.1
    └── 0.1.1/mangostudio-runtime
```

On Windows the same slot is spelled with a directory junction and an `.exe`:

```text
%USERPROFILE%\.mango\runtime\remote\
├── runtime.json
├── credentials.json               # owner-only by ACL, not by mode
├── current                        # junction -> ...\remote\0.1.1
└── 0.1.1\mangostudio-runtime.exe
```

A **slot** names who put the runtime there, not which transport talks to it. One machine
reachable by ssh *and* a dialled-in WebSocket shares one slot, one consent file, and one
binary. Config lives at the slot root and bytes under `<version>/`, so an upgrade replaces
bytes and never consent. `current` is what keeps an ssh launch argument and a service
unit's `ExecStart` from embedding a version that dangles after the next upgrade.

How it is published is the one thing that differs by platform. POSIX writes a relative
symlink beside the live one and renames it over, which is atomic. Windows writes a
**directory junction** — no privilege needed, unlike a file symlink there — and cannot
swap it in one call, because `rename` refuses an existing directory as its destination:
the old junction is unlinked first and the staged one renamed over the gap, with the old
target put back if that second step fails. A `.cmd` shim was considered and rejected: it
puts `cmd.exe` between a supervisor and the runtime, so the pid a launcher sees is not the
runtime's. Every one of these writes waits out `EPERM`, which is what a virus scanner
holding a freshly written executable looks like.

`host` holds no bytes. A release ships `mangostudio-runtime` beside the hub binary and
`host/runtime.json` records where that resolved to; `source` says whether a reader is
looking at a bundled binary, a source checkout with none, or one an install provisioned.

`runtime.json` must stay safe to paste into a bug report, which is why pairing and serve
tokens live in `credentials.json` at 0600 instead — or, on Windows, under an ACL written
with `icacls`, since `chmod` there only flips the read-only attribute. The grant is
`modify` and not read/write: every credential write publishes by renaming over the old
file, which needs delete permission on it. Writes are atomic, because two hubs can
provision one machine at once. Every field past `schemaVersion` and `slot` is optional and
unknown keys are ignored: a runtime and a hub on different versions share this file, so a
field written by a newer one must not brick an older one. The schema is
`@mangostudio/shared/runtime-home`.

### Consent

`allow` is a feature-level set — `fsRead`, `fsWrite`, `shell`, `git`, `probing`, `mcp`,
`library`, `checkpoints`, `update` — and `profile` names a preset over it: `full`,
`readonly` (reads, git, probing, and library only), `none`, or `custom` for anything else.
The stored profile is a label and the set is the decision, so the name is re-derived on
read: a hand-edited file cannot claim `readonly` over a shell grant.

**`allow.shell` grants everything a shell can reach.** `readonly` is the only profile that
meaningfully constrains a hub. The capability list is a description of the intended
surface, not a sandbox, and every consent surface says so.

Who answers depends on who installed:

- `host` and `wsl` are full with no gate. An account on this machine put them there —
  010's one-click WSL connect stays one click — and a `wsl` distribution's first provision
  records that by running the runtime's own `setup`, never by the hub writing an `allow`
  block itself.
- `remote` is pending until somebody at that machine answers. A slot with no config at all
  is *also* pending: the thing that installs a remote runtime is somebody else's hub, and
  a gate that only exists once that hub writes it is a gate that hub can decline to write.
- `connect` and `serve` are the exception, because a person is standing at the machine
  holding a token their hub printed. The invocation is the answer, and it is recorded and
  logged rather than assumed, so `health` afterwards says what the machine allows. A file
  that already says `pending` is obeyed even there — somebody deliberately staged that
  machine for an answer.
- A config that cannot be read refuses everywhere, in every slot. An unknown answer must
  not resolve to the slot default, because the file it replaced may have said something
  narrower — and for `host` and `wsl` the default is full. The same rule governs the hub
  side of WSL provisioning: an unreadable `runtime.json` in a distribution is re-written
  with the gate closed rather than re-granted.

A runtime whose slot is pending refuses before serving anything and exits non-zero with a
stable phrase (`RUNTIME_SETUP_PENDING_SIGNATURE`) that the ssh failure classifier keys on,
so "not set up yet" is never reported as "no binary there".

### Live binary updates

A connected, provisioned runtime can replace its own slot bytes through three paced
protocol methods: `runtime.update.begin`, `runtime.update.chunk`, and `runtime.update.commit`.
Bundled and source-checkout processes are not slot owners and therefore never adopt a
downloaded binary. WSL and SSH keep using their out-of-band provision/push paths, which also
lets a current hub upgrade peers from before the live-update methods existed. The hub first
downloads the exact release asset identity reported by health — including glibc versus musl —
and verifies it against the release `SHA256SUMS`; the runtime independently hashes the
received bytes before making them current.
Asset identity is channel-aware: stable uses the exact version tag and filename, while a
SHA-stamped canary resolves the rolling `v<root>-canary` tag and rolling asset name.
Chunks are sequential requests capped at 32 KiB, so the WebSocket frame queue supplies real
backpressure instead of buffering an entire binary behind a slow peer.

This is an intentional code-execution path and should be reviewed as a supply-chain surface,
not as a convenience upload. Only the runtime binary is accepted, `allow.update` is checked
before staging, one session may exist per slot across runtime processes, and ordinary tool
calls are refused from update dispatch until the session commits or the connection drops.
An interrupted or mismatched transfer removes the `.incoming` file and never changes
`current`.

Commit renames the verified file over the versioned binary and atomically swaps `current`.
The old process keeps serving its old inode until restart. A hub-spawned slot runtime exits
with a distinct update code and the hub reconnects it; a manually launched `connect` or
`serve` runtime keeps running and the card asks its owner to restart it. That restart no
longer has to be a person: one user-level service manager
(`apps/runtime/src/services/user-service-manager.ts`) now supervises both binaries — the
runtime through `mangostudio-runtime service` and the hub through `mangostudio service` —
across systemd user units, launchd agents and per-user Scheduled Tasks. A runtime that a
unit owns exits with the update code on commit and the supervisor's restart-on-failure
brings it back on the new bytes, without touching the wire contract. On Windows that is
`-RestartCount 3 -RestartInterval 1 minute`, whose one-minute floor is Task Scheduler's,
so the card shows a supervised Windows peer disconnected for about that long after a
commit. The upgrade run waits through it rather than reporting a failure over it: the
post-commit budget is one minute on every other platform and four on win32, and the
hub-dialled transports keep dialling for that whole budget instead of taking one refusal
from a peer that is only mid-interval.

Windows never replaces a running executable. The new version is a new directory beside the
old one, the junction moves, and the directory the old process is executing out of is kept
until the publication after next — which is also why the prune only ever removes a version
directory or a staged pointer, and never walks through one. The hub asks before offering
any of this: a win32 peer has to declare `publishesWindowsSlot` on its manifest, because a
build from before this existed refuses the transfer and nothing else on the health report
tells the two apart.

### Enforcement

The gate above decides whether a runtime serves at all. `allow` decides what it serves,
and it is enforced at dispatch. What a method needs is part of its definition in the
contract — every row in `apps/shared/src/runtime-contract/contract.ts` carries a
`capabilities` list keyed to the consent file's `allow` set, so a method defined without one
is a compile error there, and naming a capability nobody can grant is a compile error too.

`gateHandlers` (`apps/runtime/src/consent-gate.ts`) wraps every contract handler and reads
that list, so a host built from a narrowed `allow` answers the ones it lacks with `DENIED`
instead of running them. It is a wrapper and not the SDK's `ServeOptions.guard` on purpose:
the guard is handed the same capability list, but it never sees the parameters the audit
line summarises, cannot see how many requests are in flight — which is what update
exclusivity is decided from — and runs before the contract validates parameters, so a
refusal raised there would bypass everything below. One consequence is worth knowing: a
payload that is not an object answers `INVALID_PARAMS` and writes no audit line, because no
method call ever started.

A denied method stays registered and refuses, rather than disappearing from the map. An
absent method comes back as `METHOD_UNSUPPORTED`, which is also what an older runtime says
about a method it has never heard of — a hub cannot tell those apart, and only one of them
has a fix. The refusal carries `DENIED`, `details.kind = "consent_denied"`, the capabilities
that were missing, and the `setup` command that grants them.

The allow set is re-read on every gated call through the consent source, so a mid-connection
`setup` takes effect without reconnecting.

**Two refusal points.** The runtime is authoritative: every method that needs a denied
capability answers `DENIED` even if the hub asked anyway. The hub is cosmetic: it withholds
tools and install affordances that the connected manifest refuses
(`runtime-denied` in chat capabilities and install guards) so the UI matches what the
machine will do. A hub that offered a tool the runtime will refuse would be lying; a hub
that silently dropped one without naming the machine would be opaque.

MCP is the one capability whose refusal the hub acts on before asking. Tool rows only exist
once a session lists them, and `mcp.connect` on a refusing machine answers `DENIED` — so a
turn against such a machine snapshots the environment's enabled server rows without
connecting and reports the refusal at the server level, naming the machine. Attempting the
listing would spend the per-server budget to rediscover what the manifest already said, and
would surface as `server-unavailable` — a connection failure the user cannot act on.

Some methods need two capabilities. `library.apply` is a library operation *and* a write to
somebody's files; `readonly` grants the first and refuses the second, so listing only
`library` would have let the profile whose whole promise is "no writes" write files. The
split runs through the backup methods too: `library.backups` lists a machine's retained
sets under `library` alone, because a machine downgraded to readonly still *has* a history
and hiding it would say the backups are gone rather than that this hub may no longer write.
`library.gc`, which deletes, needs `fsWrite`.

A readonly machine is therefore a perfectly good propagation *source*: it is scanned, its
copies compete to be the winner, and only writing to it is refused. The wizard says so while
the user is still choosing, rather than letting them reach an apply that would be denied.

Local (in-process) is not exempt: it reads the `host` slot like any other runtime, so
narrowing that slot gives a read-only Local.

### Library backups across machines

Library backups are the one exception to "the runtime holds no durable user data" (006).
They stay on the machine that owned the file, under `~/.mango/library-backups` resolved
against *that* machine's home — for Local, the configured `library.backup_dir`, which stays
user-overridable and test-redirectable. Retention bounds are hub policy and apply to each
store separately: the bytes are on different disks, and one machine filling the budget must
never evict another machine's history.

The deliberate contrast is with checkpoints, which stream bytes to hub-owned blobs
(`snapshot.capture` → `~/.mango/checkpoints`) and treat the runtime as disposable. Do not
"unify" the two: a checkpoint is the hub's record of a turn, while a library backup is the
only remaining copy of a file the machine owned, and it belongs where a restore can reach it
without a hub.

Because of that, listing backups by reading manifests only works for machines the hub can
reach — so an offline machine's sets would silently vanish from the page that promises them.
A hub-side index (`library_backups`) says *that* a set exists; the manifest on the machine
says what is in it and remains the only thing a restore ever reads. Rows for a reachable
machine are reconciled against it on every listing; rows for a machine that is away render
with restore disabled and the reason stated.

A propagation that spans machines produces one backup set per machine, so it has one undo
per machine. There is deliberately no "undo everything": each is a separate conversation
with a separate host, any of which can be offline, and a single button that half-worked
would be the worst available outcome. The same holds for removal, and matters more there:
a removal's backup is the only remaining copy of what it deleted.

Removal's last-copy guard counts copies on **every machine in scope**, not on the rows the
user is looking at. A copy surviving on another box is a surviving copy — a guard that
counted only locations would nag about a resource that is not disappearing, or, in the
direction that actually costs someone their work, stay silent about one that is.

### Audit log

Each slot can append a local receipt of what a hub asked it to do. The file lives at
`~/.mango/runtime/<slot>/audit.log` (rotated siblings beside it). One NDJSON line per
protocol method records the method name, identifying arguments (paths, argv summaries,
byte counts), the hub identity when known, the outcome (`ok` / `denied` / `error`), and
duration. Consent denials are logged the same way as successful calls.

What never reaches the line is structural: file contents, shell output, and the `env`,
`headers` and `secrets` members of a request are omitted because the summariser reads an
allowlist of identifying keys rather than skipping a denylist. Credential-shaped text
*inside* a command line or argv — `--token=…`, `--token …`, `KEY_SECRET=…`,
`scheme://user:pw@host`, `Bearer …`, `X-Api-Key: …` — is scrubbed on a best-effort basis.
Best-effort is the honest word there: a shell command is arbitrary text, and it is the
structural omission, not the pattern set, that keeps known secrets off disk.

Defaults follow who reaches in: off for `host` (your machine, your hub — noise), on for
`wsl` and `remote`. `setup --audit on|off` toggles the slot; `audit [--since] [--denied]
[--json]` reads the local file.

The hub never reads this file. There is no protocol method for it, and adding one would
defeat the point. What names the asking machine is `hub: { host, user }` in the hub's own
`hello.capabilities`, announced on every session rather than on the ones a connector
remembered to name: `resolveLocalHubIdentity`
(`apps/api/src/services/runtime-client/hub-identity.ts`) reads this process's hostname and
username, and a connector that wants to announce none passes `null`. The runtime learns it
once both hellos have crossed, so a line written before that — or by a hub that stayed
silent, or one whose OS would not say — is recorded as `unidentified hub`.

A full disk or permissions failure degrades the log, not the runtime — requests keep
serving and `doctor` warns. Honest limit: once `allow.shell` is granted, anything that
shell reaches afterwards is outside the receipt.

### CLI

```text
mangostudio-runtime setup  [--profile full|readonly|none] [--allow k=v,…]
                           [--slot host|wsl|remote] [--audit on|off] [--yes] [--json]
mangostudio-runtime health [--json]
mangostudio-runtime doctor [--json]
mangostudio-runtime audit  [--since <iso|duration>] [--denied] [--json]
                           [--slot host|wsl|remote]
```

`setup` asks when it can and takes flags when it cannot; `MANGOSTUDIO_RUNTIME_SETUP` is
the same answer from the environment, which is how a container image supplies one at build
time. Flags outrank the environment, so an unusable `MANGOSTUDIO_RUNTIME_SETUP` is only
fatal when nothing overrode it — otherwise the command that repairs it could not run.
`--yes` with nothing to say yes to is an error rather than a silent default. The
non-interactive shape is what makes running `setup` over an ssh channel possible without
the hub reaching around the CLI.

`--slot` says which slot the answer is for. Without it, setup answers for the slot the
binary sits in, which is right for an installed runtime and wrong for a downloaded one:
`connect` and `serve` write `remote` wherever they run from, so those two — and every fix
`doctor` prints — name the slot in the command they recommend.

`health --json` is one payload — slot, source, version, binary, digest, profile, `allow`,
shells, git, audit on/off, any error reading the home, and any recent audit write failure —
for a terminal on the machine and for the `runtime.health` protocol method a hub calls on
a runtime it cannot run commands on. `doctor` reads that payload and names the command that
fixes each finding, because these machines are often reachable only through the thing that
is failing.

`mango doctor` on the hub reports one row per slot present in its own runtime home, so a
runtime that is installed, reachable, and refusing everything does not look identical to
one that is absent.

## Stdio Transport

`mangostudio-runtime` is a second binary built from `apps/runtime/src/cli.ts` and shipped in
every distribution channel beside the hub binary. `mangostudio-runtime --stdio` serves the
protocol over the child's own pipes, one NDJSON frame per line
([stdio](https://github.com/juliopolycarpo/mango-protocol/blob/main/spec/transports/stdio.md)).

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
own argv and reuses the spawn, handshake, and teardown path unchanged. The launcher under it
is the SDK's `spawnPort`
([spawn](https://github.com/juliopolycarpo/mango-protocol/blob/main/spec/transports/spawn.md)),
which observes and reports — the exit status, a bounded stderr tail, the
stdin/`SIGTERM`/`SIGKILL` termination sequence — and never guesses why a child failed.
Turning what it observed into a sentence somebody can act on is `spawn-runtime-child.ts`'s
job, and a wrapper that knows more supplies its own classifier.

Lifecycle:

- **Connect** spawns the child and waits up to five seconds for its `hello`. A missing binary,
  a non-executable one, and a protocol mismatch each produce their own actionable message.
- **Loss** (crash, killed process, broken pipe) fails every in-flight request with
  `UNAVAILABLE` and moves the environment to `disconnected` rather than `error`: the target
  is usually still there, only the process is gone.
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
itself but not shell children it already spawned. The runtime's own termination path reaps
those in the normal case — a shell command runs in a process group of its own and the group is
killed on timeout or abort, `taskkill /T` doing the same job on Windows (bounded, then the
direct child) — and stops reading the pipes either way, so a descendant that survives the kill
cannot hold the call open. On Linux, descendants that left the group (`setsid` / `setpgid`)
are still signalled by parentage while the leader is alive. A hard kill of the runtime can
still leave them.

The hub and the runtime ship from one release. The handshake refuses a wire major it does not
share, and for stdio `requireMatchingRelease` also refuses a runtime whose release version
differs from the hub's — the wire version only moves when the frame format does, so it cannot
catch a binary an older install left behind. `mango doctor` reports whether the sibling
binary is present and whether its version matches. It reports a warning rather than a
failure: a hub without it still serves chats through the embedded Local runtime, it just
cannot start stdio environments.

## WSL Transport

`transportKind: 'wsl'` carries `{ distro }` and is a launcher over the stdio transport
rather than a protocol of its own. The argv is
`<wsl.exe> -d <distro> --exec sh -c 'exec
"$HOME/.mango/runtime/wsl/current/mangostudio-runtime" "$@"' mangostudio-runtime`, which
the stdio spawn then appends `--stdio` to. The distribution name is an argv entry and the
script is a constant, so a name containing spaces, quotes, or shell metacharacters is data
throughout. `$HOME` is expanded by the distribution's own shell because `wsl.exe --exec`
expands nothing and the hub does not know where a distribution's home directory is — and
where a version has to appear in a script, it arrives as `$1` for the same reason.

### Which `wsl.exe`

`<wsl.exe>` above is resolved, not hard-coded, by
`apps/api/src/modules/environments/infrastructure/wsl-executable.ts`. First hit wins:

1. `MANGO_WSL_EXE`, used verbatim with no existence check — a bad override fails loudly on
   spawn instead of silently falling back.
2. `%ProgramFiles%\WSL\wsl.exe`, then `%ProgramW6432%\WSL\wsl.exe` (a 32-bit host process
   sees the redirected view under the first variable).
3. `%SystemRoot%\System32\wsl.exe`, the in-box launcher, for hosts with no MSI package.
4. `wsl.exe` on PATH, last resort.

This exists because `C:\Program Files\WSL` — where the real, actively maintained WSL 2
binary lives — is never on PATH. A bare `spawn('wsl.exe', …)` therefore always resolves to
`C:\Windows\System32\wsl.exe`, a launcher stub that reads the MSI install location out of
the registry and re-launches the Program Files binary as a fresh, unflagged process. The
hub's `windowsHide` on the process it spawned does not apply to a process it did not
create, and per [microsoft/WSL#9646](https://github.com/microsoft/WSL/issues/9646) the
stub's relaunch opens a console window in a non-elevated session. Resolving the real binary
directly means the process the hub flags is the process that does the work — no stub hop,
no window, and one fewer process creation per command. The answer is memoised per process
and logged once at info level, so a support transcript names the binary in use; `mango
doctor --env` reports it too, Windows only, with its source (`override` / `program-files`
/ `system32` / `path`).

`GET /environments/wsl` lists what the Windows host reports and marks distributions an
environment already points at. It is gated to win32 and answers every other platform with
a typed reason instead of a spawn that cannot work. Reading `wsl.exe --list --verbose`
means decoding UTF-16LE (UTF-8 under `WSL_UTF8`) and parsing by column shape: the headers
and the state column are localized, and the columns are padded to their widest value. The
answer is memoised for a short TTL, so a picker reopened or a second browser tab does not
spawn its own probe.

Connect provisions on demand, in one round trip: a single script reports the distribution's
home, its platform (`uname -s`/`-m`, `ldd --version`), and the installed runtime's own
`--version` alongside whatever `runtime.json` records. When that names another version — or
the binary it names does not run — the Linux build for this hub's own version is fetched
from its release, verified against that release's `SHA256SUMS`, cached under
`~/.mango/runtime-cache/<version>/`, and piped into the distribution (raw asset preferred;
archive fallback for older releases). A hub update is therefore absorbed by reinstalling
rather than by a handshake failure the user cannot act on. Releases publish standalone
`mangostudio-runtime-<version>-<platform>` binaries beside the platform archives
for one-liner installs and hub-driven WSL/SSH push.

The merge above collapses what used to be two separate `wsl.exe` launches — one for the
slot probe, one for the platform/version check — into one: a connect that already matches
costs a single launch instead of two, and a cold install costs one fewer launch than before.
Each launch also used to pay the System32-stub relaunch described above, so the round-trip
savings compound with the direct-binary resolution rather than being independent of it.

Which release those bytes come from is resolved by channel, not by splicing the hub's
version into a URL. Stable maps to `v<version>` and versioned asset names. A canary hub
reports `<root>-canary.<sha7>` while its assets live on the rolling `v<root>-canary` tag
under rolling names, so splicing would ask for a tag that has never existed. The cache
stays keyed on the hub's own sha-stamped version even though the fetch targets the rolling
tag, so two canary builds never share a cache entry.

A rolling tag is clobbered on every green commit, which means the asset behind a rolling
name is not necessarily this hub's pair — and its checksum verifies, because `SHA256SUMS`
was clobbered with it. Before installing from one, the hub reads `canary-manifest.json`
(published beside the assets, checksummed like them) and refuses when the tag has moved
past its own build. The refusal lands on the hub, before any remote write, instead of
surfacing as a handshake failure on somebody's machine. A rolling release that publishes
no manifest is tolerated and falls back to the install-time version check. The manifest is
only read at a layout version this hub understands; an unknown `schemaVersion` reads as no
manifest rather than as a record it would be guessing at.

The manifest's source commit is kept rather than discarded once it has served that check.
It lands in the slot's `runtime.json` beside the digest and comes back out through
`runtime health`, so "which canary is on this machine" has an answer that survives the
filename collision. It is provenance, not a gate — nothing compares it to decide whether to
reinstall, which remains the digest's job — and it is written only for a rolling install,
and cleared rather than carried, so a sha from a previous canary cannot claim a slot holds
a build it does not.

### When the release cannot be reached

Verification is what guarantees the bytes, so the fetch is authoritative whenever it
completes: a checksum the hub can read is the one it checks against, and a cached file that
disagrees with it is discarded and downloaded again.

That left a hub with no network unable to start an environment whose exact verified binary
was already in its own cache. So a checksum fetch that never reaches the release — DNS,
connect, timeout, rate limit, `5xx` — falls back to the cache instead of failing, and only
then. A release that answers has settled the question: a `404` for a version that publishes
no such asset, or checksums it cannot parse, still fails.

What may vouch for a cached file is a digest recorded when it was downloaded — the
`<file>.sha256` sidecar, or the `SHA256SUMS` kept beside it from the same download — never
one re-derived from the bytes being checked, since a file always agrees with its own hash.
No record, or a record that disagrees, is a failure naming the version that could not be
fetched. Rolling releases keep no checksums copy: the tag republishes `SHA256SUMS` under one
filename, so a copy records what the tag used to hold.

A launch that took this path says so — `offlineRuntimeCache` on the environment's connection
status, a badge on the card, and a line in the install stream for an SSH push — because a hub
that quietly stops noticing it has been offline for weeks is the failure mode this replaces.

### Staging a download without installing it

The card can fetch and verify the matching runtime into `~/.mango/runtime-cache/<version>/`
and stop there, writing nothing to the target machine. That is the half of a provision worth
keeping when somebody declines the other half: the download is the expensive, network-bound,
checksum-verified part, and the card shows the resulting path next to a `sha256sum -c` line
that checks it, so the binary can be carried over by hand. A Windows hub gets a native path
and a `Get-FileHash` line instead — the POSIX pipe assumes tools a stock Windows install does
not have.

Staging deliberately survives both push gates. `allow.update` is an answer about what a hub
may write to *that* machine, and a custom `remoteRuntimePath` is a statement that the push
helper cannot target it — neither is a reason to withhold bytes that only ever reach the hub,
and both are exactly when somebody needs them. It is offered only for WSL and SSH: a dial-in
machine the hub cannot reach gets copyable commands instead, because a copy in the hub's
cache would move nothing closer to it. When a release publishes no standalone runtime for a
platform, the archive fallback is cached instead and the run says so rather than naming a raw
path that is not there.

What lands is written down: version, digest, and which hub installed it. The digest is
what version equality cannot supply in a checkout — two `dev` builds are different
binaries with the same name, so without it a rebuilt runtime would never reach the
distribution. A release short-circuits on version alone, because a published tag's bytes
do not change and hashing tens of megabytes to learn that would be absurd. Canary counts
as a release here: its version carries the source sha, so what a slot recorded still names
one build. Consent is
recorded once, on the first provision, by running the installed runtime's own `setup`;
upgrades leave it alone. The unversioned `~/.mango/bin/mangostudio-runtime` that the first
WSL release wrote is deleted on the first install into this layout, and the removal is
logged.

A hub running from a source checkout reports version `dev`, which names no release — there
is no `vdev` tag and there never will be — so it installs the Linux runtime the checkout
built for itself, at `.mango/out/<platform>/mangostudio-runtime`, piped in whole with no
checksum to check it against. Build it with
`bun build apps/runtime/src/cli.ts --compile --target=bun-linux-x64 --outfile
.mango/out/linux-x64/mangostudio-runtime`. The absent `--define process.env.VERSION` is the
point: the runtime then reports `dev` like the hub beside it, which is what the handshake
insists on. `bun run build:binary` stamps the package version instead, and a runtime built
that way is refused with a message saying so.

A stopped distribution boots when the runtime starts, so the first connection to one is
slow — the Add Environment copy says so. Distributions on musl (Alpine) get the musl build:
the target is probed for architecture and C library together.

## Paired WebSocket Transport

`transportKind: 'websocket'` is the transport for a machine the hub cannot reach: the
runtime dials `/api/runtime` and the hub adopts the socket it arrives on. There is nothing
to configure hub-side — the config object is empty — because the machine identifies itself
with a credential rather than an address.

### Pairing

Creating the environment issues a **pairing token** from its card. It is a selector and a
verifier, `mrt_<id>.<secret>`: the hub stores the id in the clear and only the SHA-256 of
the secret, so verifying is one indexed lookup followed by a constant-time digest
comparison rather than a scan across every stored hash. The secret is readable exactly
once, in the issue response. Rotating retires the previous token and drops whatever it had
connected; revoking closes the live socket. Deleting the environment cascades the token
away with it — a credential must never outlive what it authorizes.

This is deliberately not Better Auth's apiKey plugin. With `enableSessionForAPIKeys` a
verified key resolves into a user session, and a machine credential that mints a user
session is a different security object from one that authorizes a single environment's
socket.

The card prints the commands to run on the target machine. The token goes in on stdin, or
in `MANGOSTUDIO_RUNTIME_TOKEN`; there is no argv spelling, because a command line is
readable by every process on that machine.

**The hub has to be told its own public address.** `server.publicUrl` (or `PUBLIC_URL`)
answers "how does a peer reach me", which is a different question from `server.host` and
`server.port` — those say how it binds, and a hub behind a proxy binds `0.0.0.0` while
peers use a public name. Unset, the card prints a placeholder and says what to configure.
Nothing derives it from a request header: that is a value the caller controls.

### Framing

The framing is the SDK's
([WebSocket](https://github.com/juliopolycarpo/mango-protocol/blob/main/spec/transports/websocket.md)):
frames are **chunked** across messages that fit under a 16 KiB ceiling, each chunk carrying a
nine-byte header, with
reassembly bounded by the frame limit and by the number of messages one frame can need. That
ceiling is not a preference. WebSocket payload limits are a property of the server, not of a
route: Bun takes one `websocket` option object per `Bun.serve`, and the browser bus pins
`maxPayloadLength` to 16 KiB. Raising it to fit a whole protocol frame would apply to every
browser socket too, and Bun buffers a whole message before anything validates it — a
denial-of-service regression on the bus, not a simplification.

Both ends build their port with `createWebSocketPort` from `@mangostudio/protocol/ws`, which
carries the send queue and the backpressure discipline the hub's
`closeOnBackpressureLimit: true` demands.

The upgrade names the `mango.v1` subprotocol, and the acceptor
(`apps/api/src/modules/environments/http/runtime-socket-routes.ts`) echoes it **only when the
dialer offered it**. A runtime from before the subprotocol existed offers nothing, and naming
one it did not ask for makes it drop the upgrade — before it could be told, with `4426`, that
its binary is the thing to fix.

### Liveness and reconnection

Liveness is the SDK's protocol `ping`/`pong` in both directions on its twenty-second default
cadence, well under the server-wide sixty-second idle timeout. WebSocket control frames are
not used: Bun's `sendPings` with `idleTimeout: 0` has an open defect (oven-sh/bun#26554), and
the idle timeout is a shared setting the browser bus owns. The runtime also publishes a
`runtime.heartbeat` event once a minute, which is what the route records `lastSeenAt` from
(`pairing.markSeen`) without writing on every ping.

The runtime owns the reconnect, because the hub cannot dial it:

- Close codes say why. A refused credential or a disabled environment ends the process with
  the command that fixes it — retrying those is a machine hammering an endpoint that will
  never say yes. A rate-limited close waits out the window rather than returning on the
  cadence that caused it. Everything else backs off exponentially with full jitter, so a
  rack of runtimes does not reconnect in step.
- A connection that served resets the curve.
- A second dial for the same environment **supersedes** the first, with a close code saying
  so. In-flight calls on the loser fail `UNAVAILABLE`; the next call routes to the survivor.
  The loser then **stops**, rather than redialing: two processes holding one
  pairing token would otherwise take the environment from each other on every reconnect,
  dropping in-flight calls at each handover. Which of the two should be running is a
  decision only an operator has, so the runtime says which two are fighting and exits.
- A protocol version the hub will not serve closes with its own code, separate from a
  disabled environment. Both reach the route as "unavailable" from the connection manager,
  and the remediation is not the same: enabling an environment cannot fix a stale binary.

Hub-side, a dial-in environment never latches. Five failed attempts, or a protocol
mismatch, latch a transport the hub dials; here nothing the hub does could produce the
connection a latch would be holding back — not the Connect button, not a fixed runtime
redialing. A paired environment nobody has dialed into reads as disconnected rather than
failed, because that is what it is.

### Version drift

`requireMatchingRelease` is not set for this transport. A remote runtime is not part of the
hub's own distribution, so release equality cannot be a connection gate; the wire major still
is.

That leaves a runtime a release or two behind connecting and working, which is the intent.
Drift that is allowed and invisible is drift nobody fixes, so the handshake's
`runtimeVersion` reaches the connection status along with whether it differs from the hub's,
and the card says so. The comparison happens hub-side because the hub is the only party
holding both strings; shipping its own version on every environment row so the browser could
compare would repeat one constant to answer one question.

The window that tolerance implies is wider than release equality suggests. Frame objects are
open at every level and a decoder ignores members it does not know, so two peers that share a
major keep talking while one of them grows a member; what bounds them is the effective minor,
the lower of the two the hellos announced, which neither side may send past. The
manifest is open in the same way, so a newer runtime's extra feature flags reach an older hub
as keys it drops rather than as a refused frame.

### TLS

`wss://` through a reverse proxy is the documented path. Bun's client cannot disable
certificate verification per connection (oven-sh/bun#22870) — only the process-wide
`NODE_TLS_REJECT_UNAUTHORIZED=0` works, which turns verification off for every outbound
connection that process makes. Use it for a self-signed lab and nothing else; a real
certificate is less work than the blast radius. TLS termination does not belong in the
runtime.

### Rate limiting

`/api/runtime` upgrades get their own bucket, sized well above one machine's reconnect
cadence. Buckets key on client IP, so several runtimes behind one NAT share a counter, and
a budget tuned to a single backoff curve would let one broken runtime rate-limit every
healthy one beside it.

The bucket is counted in the route rather than in the global HTTP hook, which exempts this
path. A dialing runtime has no response body to read: an HTTP 429 before the upgrade reaches
it as a socket that simply failed to open, indistinguishable from a hub that is down, so it
would come back on the generic backoff instead of waiting out the window. Refusing after the
upgrade costs one socket and buys a close code the peer can act on.

## Direct URL Transport

`transportKind: 'http'` is the transport for a machine the hub can already reach. The
runtime listens with `mangostudio-runtime serve` (`apps/runtime/src/serve.ts`); the hub
dials the configured `baseUrl` over WebSocket with a bearer token from the OS secret store.
Framing, liveness and close codes are the same as the paired socket — the 16 KiB message
ceiling is mandatory even though `Bun.serve` could raise its payload limit — and the listener
echoes `mango.v1` only when the dialer offered it, for the same reason the paired acceptor
does.

A dial that neither opens nor fails is bounded here rather than by the connection manager: a
host that accepts the TCP connection and then says nothing produces no `open`, no `error` and
no `close`, so `connect-http-runtime.ts` carries a `dialDeadline`
(`apps/api/src/services/runtime-client/dial-deadline.ts`) that aborts the dial with the
message the card will show.

Config is `{ baseUrl }` (`http://` or `https://`). The serve token is write-only: it is
never returned by the API, only whether one is stored (`hasRuntimeToken`). Private and
loopback hosts are allowed — LAN reachability is the point — and the UI warns when the URL
is plaintext HTTP to a public host. On the runtime side, inject a per-run serve secret with
`MANGOSTUDIO_RUNTIME_SERVE_TOKEN` (or stdin); that path does not write the credential to
disk. `MANGOSTUDIO_RUNTIME_TOKEN` stays the pairing credential for `connect`.

**One serve process maps to one user environment.** A second hub (or a second connection
from the same hub) that upgrades successfully supersedes the previous socket with close
code `4409`. Multi-user sharing of one listening runtime is therefore a supersede race,
not a multiplexed session; give each environment its own listen address or its own token
and process if more than one hub should use that machine.

The runtime does not terminate TLS. Put a reverse proxy in front when the dial crosses an
untrusted network. The same Bun self-signed client caveat as paired WebSocket applies when
the hub dials `wss://` against a certificate it does not trust.

## SSH Transport

`transportKind: 'ssh'` carries `{ host, user?, port?, identityFile?, remoteRuntimePath? }` and
is a launcher over the stdio transport, not a protocol of its own. The hub spawns the system
`ssh` client and the runtime runs on the far end of the pipe it opens. Nothing about the
framing, handshake, or teardown differs from a local child.

Reusing OpenSSH is the point: keys, agents, `~/.ssh/config`, `ProxyJump`, and `known_hosts` all
apply because it is the same client the user already runs, and MangoStudio holds no credential
of its own for that machine.

### Argv

The option list is the SDK's hardened `ssh` preset
([spawn](https://github.com/juliopolycarpo/mango-protocol/blob/main/spec/transports/spawn.md),
*SSH preset*) rather than one this repository maintains: `BatchMode=yes`, so a connection
that would prompt fails rather than hanging until the handshake times out; a bounded
`ConnectTimeout` and server keepalives;
`StrictHostKeyChecking=yes` set explicitly, so an unknown host key is refused rather than
accepted — the first trust decision belongs to a person at a terminal, and the card prints the
`ssh <host> true` that makes it; multiplexing and `RemoteCommand` forced off, because a user's
own config could otherwise enable either under a long-lived pipe; `-T`, because stdout carries
frames a tty would translate; `--` before the destination and a refusal of any host or user
beginning with a dash, so a host spelled `-oProxyCommand=…` cannot become an option; and the
remote path single-quoted with a leading `~/` left outside the quotes, because `ssh` hands
everything after the destination to the target's login shell.

`sshLaunch` (`apps/api/src/services/runtime-client/connect-ssh-runtime.ts`) supplies the one
MangoStudio decision the preset does not have: where a runtime our installer placed lives. The
stdio spawn appends its own `--stdio` afterwards, exactly as it does for WSL.

`remoteRuntimePath` defaults to `~/.mango/runtime/remote/current/mangostudio-runtime`, whose
last directory is a symlink an installer swaps, so the default never embeds a version. Targets
are Linux and macOS: a Windows ssh *target* is not supported, since path style, quoting, and
`.exe` resolution all differ. A Windows *hub* is — `ssh` resolves from PATH, and `mango doctor`
reports whether it is there, because OpenSSH is an optional feature on Windows.

### Failures are read out of stderr

`ssh` reports every failure of its own — refused authentication, an unverified host key, a
timeout, a name that does not resolve — as **exit 255**, and passes a remote command's status
through otherwise. The exit code therefore cannot say what went wrong. The cause is read from a
table of the client's own message forms, with the shell's 127 and 126 used where they are
unambiguous, and each reason maps to a card that names the fix: install a runtime there, run
`chmod +x`, trust the host key by hand, run `setup` on that machine. A signature that does not
match falls back to handing the user ssh's own words rather than a confident wrong diagnosis —
the client's text is locale-dependent in theory.

One case is worth naming: a runtime that is installed but whose owner has not said what it may
do prints a stable phrase and exits non-zero, which looks exactly like a shell reporting a
missing file. It is classified first, so a consent gate never sends someone to reinstall a
runtime that is already there.

### Lifecycle

Identical to stdio, because it is stdio: a lost connection is a closed pipe, and the manager's
lazy deadline backoff re-runs `ssh` on the next call that needs it. The handshake budget is
larger — twenty seconds rather than five — because a TCP round trip, a key exchange, and a
remote process start all happen before the first frame. Keepalives make a dead network surface
as a closed pipe within about forty-five seconds.

`requireMatchingRelease` is off here, as for the other remote transports: the binary on that
machine is not part of this hub's distribution, so release equality cannot gate the connection
and the wire major is what does. Drift is reported on the card.

Provisioning is not part of this transport. The runtime has to be installed on the target
already, and the card prints the commands that check what is there.

## Container Transport

`transportKind: 'container'` spawns `docker` or `podman` and runs the stdio transport through
the pipe. A launcher, like WSL and SSH — no new protocol, and no daemon inside the container.

The `engine` field selects a binary name and nothing else. Every flag this transport passes
(`--rm -i --init --name --pull=never --network --cpus --memory -v --entrypoint`) is accepted by
both CLIs; the moment one of them needed its own argv, the field would stop being a name and
become a fork, which is not what it is for.

### Nothing is baked into an image

The image belongs to the user and is never modified. The runtime binary is bind-mounted
read-only at `/opt/mangostudio-runtime` and run as the container's entrypoint, so the version
inside the container follows the hub's without an image rebuild and without MangoStudio
publishing images of its own.

The bytes come from the same channel-aware resolver every other provisioning path uses, into
the same `~/.mango/runtime-cache/<version>/`. A source checkout mounts the build it made for
itself under `.mango/out/<platform>/` instead, and says which command produces one when there
is none.

Which build is needed is a question about the image, so it is asked of the image: one
`sh -c 'uname -s; uname -m; ldd --version'` inside it, the same probe WSL and SSH targets
answer. That is what distinguishes an Alpine image (musl) from a Debian one (glibc), which
`uname -m` alone cannot. An image with no shell fails there with a typed error rather than at
launch — using a shell-bearing image is a documented limit of this transport.

### What an image has to provide

Three requirements, in the order they bite:

1. **A shell (`sh`)**, or the platform probe cannot run and the environment fails with
   "use a shell-bearing image". Distroless images are out of scope for this reason.
2. **`libstdc++` on musl images.** A Bun-compiled musl binary links against it, so the runtime
   cannot start on a bare `alpine` — it dies relocating symbols before the handshake.
   `Dockerfile.alpine` installs it for exactly this reason. Glibc images already have it.
3. **`bash` or `zsh` for the shell tool.** Those are the shell kinds the protocol defines, and
   Alpine ships neither by default. Everything else — filesystem, Git, probing, MCP — works
   without them; only the shell tool needs one present.

An image that satisfies all three is the difference between "the sandbox works" and "the
sandbox works and agents can use a terminal in it". `alpine:3` plus
`apk add --no-cache bash libstdc++` is the smallest image that does.

The probe result is cached against the image *id* the engine reported, not the image name. A
tag is a moving target, so keying on identity means a re-pulled image misses the cache by
construction rather than by an invalidation rule.

### Pulling is a phase, not a hang

A missing image is pulled on demand. A cold pull of a large image runs for minutes, so it is
reported as its own phase and the card says "Pulling image" instead of showing `connecting`
long enough to read as a hub that has stopped answering. The launch itself passes
`--pull=never`: by then the image is present, and a silent download inside the handshake window
is the one shape this must not have.

### Consent, and which direction the isolation points

There is no setup step. The mounted binary lives outside the runtime home, so
`resolveRuntimeSlot` resolves it to `host`, whose default is full consent — the same case the
Docker image regression test pins. Nothing is written inside the container, and nothing needs
to be: the container is gone at the end of the connection.

The protection points at the agent, not at the hub. A container is what makes `allow.shell`
safe to grant, because it bounds what a shell can reach to a filesystem that is discarded
afterward — for whatever the image itself provides. A `mounts` entry is host-backed and does
not share in that discarding: it stays exactly as writable (or, with `readonly`, as unwritable)
as it was outside the container. It is **not** a boundary against whoever configures the
environment: the engine runs as the hub's own user and is host-root-equivalent, so an
environment that can start containers can already do anything on the machine.

That is why the mount denylist is enforced rather than documented. A mount of the engine
socket, `/proc`, `/sys`, `/var/run` or `/run` is refused by the shared validator that both the
browser form and the connector run, because any of them would let a process inside step back
out. Resource limits (`cpus`, `memoryMib`) bound consumption; they are not part of the
boundary and no copy presents them as if they were.

### Ephemeral by construction

The container filesystem is discarded when the connection ends. Agent homes, package caches
and any written file vanish with it, and library propagation into an unmounted container home
is correct and pointless. Anything that has to survive is an explicit `mounts` entry.

`--rm` plus the runtime exiting on EOF is the ordinary teardown. Killing the engine's client
process does not stop the container it started, so the connector also kills by the name it
generated for that launch — never by image, since two environments may share one.

### Lifecycle

Identical to stdio, because it is stdio. The handshake budget is twenty seconds rather than
five, to cover creating the container and starting an init before the first frame.

`requireMatchingRelease` stays **on**, unlike the remote transports: the binary in the container
is this hub's own, mounted from its own cache, so a mismatch means the resolution is wrong
rather than that a peer runs its own install. There are no install, upgrade or setup actions on
the card for the same reason — there is nothing on the far side to install, and a read-only
bind mount has nothing to write to.

## Paths Across Hosts

An environment need not run the operating system the hub runs on, and there is no path
translation layer: a path inside a WSL distro is a native Linux path from end to end, and
nothing rewrites it on the way. What the hub does instead is *resolve* in the target's
terms.

Tools take absolute paths, `~` paths, and paths relative to the chat working directory, and
the hub turns those into one absolute path before it calls. Both inputs to that are facts
about the target, and both arrive in the `hello` manifest:

- `homeDir` expands `~`. The hub's own `HOME` describes the wrong machine, and on Windows it
  is usually not set at all. A manifest is a claim by the other end, so a `homeDir` that is
  not absolute in the target's own style is dropped: `~` then stays literal and fails as a
  name the target does not have, rather than resolving against the hub's working directory.
- `pathStyle` selects the separator, the notion of absoluteness used to join and fold the
  result, and whether two paths that differ only in case are the same path — on a `win32`
  target they are, so comparisons fold case while the paths themselves keep theirs.
  Resolution is purely lexical and never consults the hub's working directory, which is a
  directory the target need not have. The one base it cannot check for itself is the chat
  working directory; `resolveWorkdirRelativePath` refuses a relative one rather than
  silently anchoring it to the hub.

`RuntimeClient.paths` exposes both, read from the connection that will receive the call, so
one environment's manifest cannot be paired with another's connection.

Policy is decided the same way and enforced somewhere else. The hub checks allowed roots,
denied roots, and workdir containment lexically, then sends the same roots along as
`pathPolicy`; the runtime re-checks the call's paths after following symlinks, because a
link inside the working directory that points out of it exists on the target's disk and is
invisible from the hub. A call with nothing configured and no restriction carries no policy.

`pathPolicy` is optional on the wire, so a hub can talk to a runtime built before it
existed. That tolerance is the one place where it matters what "optional" costs: the older
peer accepts the field, ignores it, and answers exactly like a peer that enforced it, so
nothing about the call says the enforcement went missing. `enforcesPathPolicy` on the
manifest is the answer to that — absent means **false**, unlike the `features` keys, because
a peer that has not answered the question has not answered it in the affirmative. When the
hub sends a containment root to a peer that does not declare enforcement it warns once per
connection naming the environment, and the environment card says so.

**Follow-up:** once no supported runtime predates `enforcesPathPolicy`, `pathPolicy` becomes
required on every filesystem method and the tolerance above goes away with it. Until then
the declaration is what keeps the gap legible rather than silent.

## Extending the Boundary

Add a runtime operation as one coherent change:

1. Define its serializable parameters and result in
   `apps/shared/src/runtime-contract/methods.ts` (`apps/runtime/src/methods.ts` is a
   re-export, so the runtime's own services keep their import path), then add the row to the
   method table in `apps/shared/src/runtime-contract/contract.ts` with the capabilities it
   needs. A row without a capability list is a compile error, and so is a capability the
   consent file cannot grant. The answer is a *set*: a method that both reads a domain and
   causes effects names both capabilities, or the profile that refuses the second still runs
   it. The gate decides on the method's list and never on its params, so a read/write split
   has to be two methods.
2. Give the row real TypeBox schemas if the shapes have them. Most rows carry
   `UnsafeObjectSchema`: the type is exact and the validation `serve` runs before a handler
   sees the payload is "is a JSON object". Replacing one with a real schema is a local change
   and nothing else moves.
3. Register the handler in `apps/runtime/src/registry.ts` — the map is typed by the contract,
   so a missing one is a compile error there rather than a method that answers
   `METHOD_UNSUPPORTED` at runtime — and keep host effects inside `apps/runtime/src/services/`.
4. Expose the typed call through the `RuntimeClient` facade in
   `apps/api/src/services/runtime-client/`.
5. Keep authorization, product policy, and durable persistence in the API.
6. Test the handler directly and test any cancellation or error translation at the API
   boundary.

A method that also announces a **capability** — a binary it needs, a feature it can only
offer on some machines — has two more legs, and forgetting either ships green:

7. Add the field to `RuntimeCapabilityManifestSchema`
   (`apps/shared/src/runtime-contract/manifest.ts`) as `Type.Optional`, and populate it from
   `createLocalRuntimeManifest` (`apps/runtime/src/manifest.ts`). Required would fail decode
   for every older peer; document whether absent means granted or unavailable, because the
   two readings already coexist in that schema — the original `features` keys mean granted,
   `externalAgents` and `gh` mean unavailable.
8. Add the same field to `RuntimeHealthReportSchema` (`apps/shared/src/runtime-home/`), emit it
   from `apps/runtime/src/health.ts`, and carry it in `capabilityManifestFromHealth`
   (`apps/api/src/services/runtime-client/manifest-from-health.ts`). **This is the leg that
   fails silently.** The hub rebuilds a remote peer's manifest from `runtime.health` after any
   consent change and cannot probe another machine, so a capability that travelled only on
   `hello` disappears on the first refresh — with nothing logged and every test still passing.
   Assert it in `manifest-from-health.test.ts`.

Neither version moves for an additive method. `RUNTIME_CONTRACT_VERSION` is announced, not
compared, and the wire version only changes when the frame format does; an older runtime
answers `METHOD_UNSUPPORTED`, which is a normal decodeable outcome.
