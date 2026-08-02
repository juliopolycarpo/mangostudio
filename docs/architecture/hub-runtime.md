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
| Lexical path resolution and containment                                       | Hub (`apps/api`)                | `TargetPaths` resolves `~` and relative input in the target's style, then checks allowed, denied, and containment roots as string prefixes. Decides; never the last word.                       |
| Link-resolved path containment                                                | Runtime (`apps/runtime`)        | Shared `isPathPrefix` / ancestor resolution / `assertInsideWorkdir`. Only the host holding the filesystem can see that a name inside a root is a symlink out of it.                             |
| Path policy on filesystem calls                                               | Hub policy, runtime enforcement | The hub serializes allowed, denied, and containment roots as `pathPolicy`; the runtime enforces them link-resolved on every filesystem method, including the candidates glob and grep discover. |
| Filesystem reads, writes, patches, glob, and grep                             | Runtime (`apps/runtime`)        | The runtime owns host I/O, mutation locking, and result hashing.                                                                                                                                |
| Shell discovery, environment filtering, execution, timeout, and output bounds | Runtime (`apps/runtime`)        | The hub selects settings; the runtime applies them where the process is spawned.                                                                                                                |
| Git CLI execution (`git.exec`, argv-array-only)                               | Runtime (`apps/runtime`)        | Hardened spawn, env whitelist, timeout, and output bounds; the hub keeps parsers, locks, and routes.                                                                                            |
| Per-chat read freshness state                                                 | Runtime (`apps/runtime`)        | This cache is disposable and can be rebuilt through normal reads.                                                                                                                               |
| Pre-mutation capture, current-state hashing, and revert effects               | Runtime (`apps/runtime`)        | Mutation responses include serializable before snapshots and resulting hashes. Optional `containmentRoot` on revert.                                                                            |
| Checkpoint manifests, blobs, retention, and reverted state                    | Hub (`apps/api`)                | Durable checkpoint state remains in SQLite and hub-managed blob storage.                                                                                                                        |
| MCP sessions: the SDK, the child process, the outbound HTTP request           | Runtime (`apps/runtime`)        | A server row names an environment; its session opens there. Only `apps/runtime/src/services/mcp/**` may import `@modelcontextprotocol/sdk`.                                                     |
| MCP server rows, secrets, tool naming, and the pending elicitation registry   | Hub (`apps/api`)                | The wire names a model sees must not change with placement; secrets live in one store and are delivered at connect. See [mcp.md](../reference/mcp.md).                                          |
| Toolchain, version-manager, and agent-CLI detection (`probing.*`)             | Runtime (`apps/runtime`)        | PATH scans, version spawns, auth-signal stats, and library location stats all describe the machine they run on. Per-scan budgets live with the spawns they bound.                               |
| Detection policy: recipes, Node release data, cache freshness                 | Hub (`apps/api`)                | Installability, live LTS metadata, and how long an answer may be reused are hub decisions and travel down as parameters. Cache keys include the connection, so a reconnect drops what it said.  |
| Install execution (`install.run`, `install.cancel`)                           | Runtime (`apps/runtime`)        | The argv arrives already built from a code-defined recipe; output streams back on `install.output`. See [environment-installs.md](environment-installs.md).                                     |
| Install recipes, guards, audit rows, and the SSE stream                       | Hub (`apps/api`)                | Whether a recipe may run — including the per-environment `allowInstalls` opt-in — and the system of record for what ran.                                                                        |
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

| Transport                 | Status  | Direction        | Framing                                                                                      |
| ------------------------- | ------- | ---------------- | -------------------------------------------------------------------------------------------- |
| Embedded in-process ports | Current | —                | FIFO structured frames; development and tests round-trip every frame through the byte codec. |
| Local runtime process     | Current | Hub spawns       | Bounded NDJSON over the child's pipes, using the same handshake and request ids.             |
| WSL distribution          | Current | Hub spawns       | The stdio transport, launched through `wsl.exe`. A launcher, not a framing of its own.       |
| Paired WebSocket          | Current | Runtime dials in | Chunked binary frames over one socket to `/api/runtime`, authenticated by a pairing token.   |
| Direct URL                | Current | Hub dials out    | Same chunked WebSocket framing; the runtime listens and the hub presents a serve token.      |
| SSH                       | Current | Hub spawns       | A launcher over stdio: the system `ssh` client, with the runtime on the far end of its pipe. |

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
  needs no credential of MangoStudio's own. The runtime has to be installed on that machine
  already; nothing is pushed there yet.

The shared NDJSON codec validates every frame, buffers partial lines, and rejects records
larger than 16 MiB. Production in-process delivery uses structured cloning while retaining
schema validation, so embedded execution cannot exchange values a byte transport could not
represent during development and tests.

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

A **slot** names who put the runtime there, not which transport talks to it. One machine
reachable by ssh *and* a dialled-in WebSocket shares one slot, one consent file, and one
binary. Config lives at the slot root and bytes under `<version>/`, so an upgrade replaces
bytes and never consent. `current` is what keeps an ssh launch argument and a service
unit's `ExecStart` from embedding a version that dangles after the next upgrade; it is
published with `ln -sfn`, which creates a temporary link and renames it over the old one.

`host` holds no bytes. A release ships `mangostudio-runtime` beside the hub binary and
`host/runtime.json` records where that resolved to; `source` says whether a reader is
looking at a bundled binary, a source checkout with none, or one an install provisioned.

`runtime.json` must stay safe to paste into a bug report, which is why pairing and serve
tokens live in `credentials.json` at 0600 instead. Writes are atomic, because two hubs can
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

A runtime whose slot is pending refuses before serving anything and exits non-zero with a
stable phrase (`RUNTIME_SETUP_PENDING_SIGNATURE`) that the ssh failure classifier keys on,
so "not set up yet" is never reported as "no binary there".

### CLI

```text
mangostudio-runtime setup  [--profile full|readonly|none] [--allow k=v,…] [--yes] [--json]
mangostudio-runtime health [--json]
mangostudio-runtime doctor [--json]
```

`setup` asks when it can and takes flags when it cannot; `MANGOSTUDIO_RUNTIME_SETUP` is
the same answer from the environment, which is how a container image supplies one at build
time. `--yes` with nothing to say yes to is an error rather than a silent default. The
non-interactive shape is what makes running `setup` over an ssh channel possible without
the hub reaching around the CLI.

`health --json` is one payload — slot, source, version, binary, digest, profile, `allow`,
shells, git, and any error reading the home — for a terminal on the machine and, from 019,
for the `runtime.health` protocol method a hub calls on a runtime it cannot run commands
on. `doctor` reads that payload and names the command that fixes each finding, because
these machines are often reachable only through the thing that is failing.

`mango doctor` on the hub reports one row per slot present in its own runtime home, so a
runtime that is installed, reachable, and refusing everything does not look identical to
one that is absent.

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

## WSL Transport

`transportKind: 'wsl'` carries `{ distro }` and is a launcher over the stdio transport
rather than a protocol of its own. The argv is
`wsl.exe -d <distro> --exec sh -c 'exec
"$HOME/.mango/runtime/wsl/current/mangostudio-runtime" "$@"' mangostudio-runtime`, which
the stdio spawn then appends `--stdio` to. The distribution name is an argv entry and the
script is a constant, so a name containing spaces, quotes, or shell metacharacters is data
throughout. `$HOME` is expanded by the distribution's own shell because `wsl.exe --exec`
expands nothing and the hub does not know where a distribution's home directory is — and
where a version has to appear in a script, it arrives as `$1` for the same reason.

`GET /environments/wsl` lists what the Windows host reports and marks distributions an
environment already points at. It is gated to win32 and answers every other platform with
a typed reason instead of a spawn that cannot work. Reading `wsl.exe --list --verbose`
means decoding UTF-16LE (UTF-8 under `WSL_UTF8`) and parsing by column shape: the headers
and the state column are localized, and the columns are padded to their widest value.

Connect provisions on demand. The distribution is asked where its home is and what its
`runtime.json` records, and when that names another version — or the binary it names does
not run — the Linux build for this hub's own version is fetched from its release, verified
against that release's `SHA256SUMS`, cached under `~/.mango/runtime-cache/<version>/`, and
piped into the distribution's own `tar`. A hub update is therefore absorbed by
reinstalling rather than by a handshake failure the user cannot act on. There is no
standalone runtime asset in a release yet, so the platform archive is fetched and one
member is extracted from it.

What lands is written down: version, digest, and which hub installed it. The digest is
what version equality cannot supply in a checkout — two `dev` builds are different
binaries with the same name, so without it a rebuilt runtime would never reach the
distribution. A release short-circuits on version alone, because a published tag's bytes
do not change and hashing tens of megabytes to learn that would be absurd. Consent is
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

WebSocket payload limits are a property of the server, not of a route. Bun takes one
`websocket` option object per `Bun.serve`, and the browser bus pins `maxPayloadLength` to
16 KiB. Raising that to fit a 16 MiB protocol frame would apply to every browser socket
too, and Bun buffers a whole message before anything validates it — a denial-of-service
regression on the bus, not a simplification. So frames are **chunked** above the socket:
each message carries a nine-byte header (format version, chunk index, chunk count), and
reassembly is bounded by the same 16 MiB limit the codec enforces on a whole frame.

Every chunk leaves through **one queue per connection**. The host resolves requests
concurrently, so without it two oversized responses would interleave their chunks into a
stream neither peer can reassemble. The queue also carries the backpressure discipline the
hub's `closeOnBackpressureLimit: true` demands: it pauses when a send is buffered and
resumes on drain.

### Liveness and reconnection

Liveness is protocol `ping`/`pong` in both directions on a twenty-second cadence, well
under the server-wide sixty-second idle timeout. WebSocket control frames are not used:
Bun's `sendPings` with `idleTimeout: 0` has an open defect (oven-sh/bun#26554), and the
idle timeout is a shared setting the browser bus owns. The runtime also publishes a
`runtime.heartbeat` event, which is what the hub records `lastSeenAt` from without writing
on every ping.

The runtime owns the reconnect, because the hub cannot dial it:

- Close codes say why. A refused credential or a disabled environment ends the process with
  the command that fixes it — retrying those is a machine hammering an endpoint that will
  never say yes. A rate-limited close waits out the window rather than returning on the
  cadence that caused it. Everything else backs off exponentially with full jitter, so a
  rack of runtimes does not reconnect in step.
- A connection that served resets the curve.
- A second dial for the same environment **supersedes** the first, with a close code saying
  so. In-flight calls on the loser fail `RUNTIME_UNAVAILABLE`; the next call routes to the
  survivor. The loser then **stops**, rather than redialing: two processes holding one
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
hub's own distribution, so release equality cannot be a connection gate; the protocol
major/minor pair still is.

That leaves a runtime a release or two behind connecting and working, which is the intent.
Drift that is allowed and invisible is drift nobody fixes, so the handshake's
`runtimeVersion` reaches the connection status along with whether it differs from the hub's,
and the card says so. The comparison happens hub-side because the hub is the only party
holding both strings; shipping its own version on every environment row so the browser could
compare would repeat one constant to answer one question.

The window that tolerance implies is also narrower than it sounds. Every frame schema sets
`additionalProperties: false`, so two peers on the same major/minor still refuse each
other's frames the moment one of them adds a field. Until the protocol adopts tolerant
decoding, "compatible" means the same build of the schema, not the same version of it.

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
runtime listens with `mangostudio-runtime serve`; the hub dials the configured `baseUrl`
over WebSocket with a bearer token from the OS secret store. Framing is the same chunked
binary protocol as paired WebSocket — the 16 KiB message ceiling is mandatory even though
Bun.serve could raise its payload limit.

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

```text
ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15
    -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes
    -o ControlMaster=no -o ControlPath=none
    [-o IdentitiesOnly=yes -i <identityFile>] [-p <port>]
    -T -- <[user@]host> <quoted remoteRuntimePath>
```

The stdio spawn appends its own `--stdio`, exactly as it does for WSL. Every forced option is
load-bearing:

- `BatchMode=yes` — nothing on the hub can answer a prompt, so a connection that would ask must
  fail rather than hang until the handshake times out.
- `StrictHostKeyChecking=yes` is set explicitly rather than left at the default `ask`, which
  fails under batch mode anyway and which ambient config could relax to `no`. An unknown host
  key is refused, not accepted: the first trust decision belongs to a human at a terminal. The
  card prints the `ssh <host> true` that makes it, and says why.
- `ControlMaster=no ControlPath=none` — multiplexing is unsupported by Windows OpenSSH and a
  user's config could otherwise enable it under a long-lived pipe. Reusing a master connection
  would speed reconnects; it is deliberately out of scope.
- `-T` — no pseudo-terminal, because stdout carries protocol frames a tty would translate.

**A host named `-oProxyCommand=...` would be remote code execution on the hub.** Three layers
stop it and all three are load-bearing: the schema refuses any value starting with a dash, `--`
ends option parsing before the destination, and argv is an array rather than a command string.

The remote side plays by OpenSSH's rules, not ours. `ssh` joins everything after the
destination with spaces and hands the result to the target's **login shell** — which is why `~`
expands at all — so `remoteRuntimePath` is single-quoted by the argv builder: a path with a
space would otherwise arrive as two words, and one holding `;` or a backtick as a second
command. A leading `~/` is left outside the quotes, because no shell expands a tilde inside
them.

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
and the protocol major/minor pair is what does. Drift is reported on the card.

Provisioning is not part of this transport. The runtime has to be installed on the target
already, and the card prints the commands that check what is there.

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

## Extending the Boundary

Add a runtime operation as one coherent change:

1. Define its serializable parameters and result in `apps/runtime/src/methods.ts`.
2. Register a runtime handler and keep host effects inside `apps/runtime/src/services/`.
3. Expose the typed call through `apps/api/src/services/runtime-client/`.
4. Keep authorization, product policy, and durable persistence in the API.
5. Test the handler directly and test any cancellation or error translation at the API
   boundary.
