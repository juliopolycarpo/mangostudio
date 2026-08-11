# External Agents

An **external agent** is a vendor CLI — Codex, Cursor, Claude Code — that MangoStudio hosts
rather than reimplements. When one runs a turn, the vendor owns everything that matters:
authentication, model choice, context, tools, permissions, sandboxing, approvals and its own
session state. MangoStudio discovers the CLI in the user's selected environment, spawns it
through the runtime, relays input, renders normalized events, forwards approvals, and cancels.
Nothing more.

## The invariant

> **External agents never own MangoStudio tools. They use their own tools, and MangoStudio only
> surfaces them in the interface.**

External tool activity is *observational*. It is rendered and persisted; it never enters
MangoStudio's tool registry, executor, permission engine, workdir policy or budget accounting.
This is why the event contract calls them `activity` rather than `tool` — the name is the same at
every call site, so nothing reads as executable that is not.

Two concrete ways this could be violated, both closed by construction:

1. A vendor can send a **request asking the client to execute a tool**. Codex's `item/tool/call`
   is exactly that, and its handshake offers no way to decline it in advance. It is answered with
   a protocol error, always.
2. External assistant text persisted as an ordinary `text` part would be **replayed into
   MangoStudio's own model context** on a later internal turn — the vendor's claims inherited as
   MangoStudio's own prior output, while the external activity that produced them is dropped.
   One runner kind per chat removes the possibility rather than mitigating it.

## Ownership

| Concern                               | Owner            | Notes                                                                                                    |
| ------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| Vendor authentication and credentials | Vendor CLI       | MangoStudio never holds, forwards or renews a vendor credential. Sign-in happens in the user's terminal. |
| Model choice and reasoning effort     | Vendor CLI       | Catalogs come from the adapter or the live session, never from a hub-side table.                         |
| Tool definitions and execution        | Vendor CLI       | MangoStudio's registry is not offered to it and its tools do not enter ours.                             |
| Permission decisions and sandboxing   | Vendor CLI       | MangoStudio picks a configuration the adapter said it supports and forwards the user's answers.          |
| Conversation state and continuation   | Vendor CLI       | The vendor's session handle is server-owned; no client request writes it.                                |
| Discovery of the CLI                  | Runtime          | The binary, its version and its status command all live on the machine the runtime runs on.              |
| Product copy, policy, caching, authz  | Hub (`apps/api`) | Which targets exist, what they are called, who may ask, and how long an answer may be reused.            |
| Contracts                             | Shared           | Schema-first in `apps/shared/src/external-agents/`, browser-safe, imported by hub, runtime and frontend. |
| Transcript, rendering and persistence | Hub + frontend   | The normalized event stream is stored and drawn; it is never fed back to a MangoStudio model as context. |

## Execution admission

Adapter support, runtime consent and OS identity isolation are separate proofs. A Local runtime
may attest `single-user-host` only after one authenticated MangoStudio user connects successfully.
If a second user appears, the hub closes every attested Local connection before continuing without
an attestation. Ordinary Local runtime features remain available, but external agents stay hidden
because the credential home is no longer proven to belong to one MangoStudio user.

Workspace access is independently fail-closed. Before an adapter can launch, the runtime requires
canonical directory paths and asks its host to authorize each one. The production Local host accepts
only an exact canonical workdir already stored on a Local chat owned by the same user. Hosts without
an explicit authorization source deny every workspace.

**Opening a session is the only place a workspace root is authorized.** Turn configuration reaches
the vendor verbatim as its sandbox roots, so a turn may name a subset of the roots its session
opened with and never a root outside them — including one the host's own policy would otherwise
allow. An adapter that wants a wider set has to make the caller open a new session for it.

## Why a separate bounded context

An external agent is not an `AgentProfile` and not an `AIProvider`.

- An **`AgentProfile`** configures MangoStudio's own loop: a system prompt, a tool list, a model.
  Every field of it presumes MangoStudio decides what runs. None of those decisions exist here.
- An **`AIProvider`** serves *models* through MangoStudio's agent loop — MangoStudio still owns
  the tools, the permissions and the turn. A vendor CLI owns all three itself.

Modelling either way would mean adding "…except when it is external" to every field, and the
first such exception that is forgotten is a MangoStudio tool executing on a vendor's say-so. The
separate context is what makes that unrepresentable.

The distinction is not about the vendor: serving ChatGPT models through MangoStudio's own loop
and hosting the Codex CLI are different products that happen to share a company.

## One runner kind per chat

A chat's transcript has one owner for life. Switching between MangoStudio and an external agent
offers to continue in a **new** chat, carrying the environment and workdir but not the transcript.

The reason is mechanical rather than aesthetic. MangoStudio builds a model's context from the
`text` and `thinking` parts of the chat's history. External assistant text stored as a `text` part
would therefore be replayed to MangoStudio's own model as its own previous output, while the
`external_activity` parts that explain how it was produced are not part of that context at all.
The model would inherit "I did X" from a third-party process, with no record of how.

## Discovery

Answering *which external agents exist here, are they installed, are they signed in, and what can
each one do* takes two tiers, in this order:

1. **The cheap pass** — the environment scanner that already runs for the Environments UI
   (`probing.agentClis`). It looks for the binary and its credential-adjacent files, is already
   cached and single-flighted, and decides whether a target is worth escalating.
2. **The authoritative pass** — the runtime's discovery operation, which runs the vendor's own
   structured status command and answers from the **adapter that would run the turn**. Where the
   two disagree, this one wins. `unknown` survives only when the status command is unavailable,
   times out, or returns something unrecognized. A live runtime consent refusal remains the
   authoritative `runtime-denied` result even when the handshake manifest was cached before the
   consent change.

The hub spawns no vendor CLI and keeps no second capability table.

**Discovery is not free.** The authoritative pass is a subprocess on someone else's machine, so it
carries a stated budget: a per-call timeout, a cache TTL per (user, environment), a single-flight
so a burst of selector renders produces one probe, and a cap on concurrent discoveries per
environment. Ordinary probe failures — timed out, unreachable, over the cap — degrade to the cheap
pass; an owner refusal remains unavailable. Discovery never fails the request: an environment that
cannot be reached at all is answered
with one unavailable descriptor per target, because a selector that cannot render is worse than
one showing a greyed row with a reason.

Entry points:

- `apps/shared/src/external-agents/schemas.ts` — the contracts
- `apps/api/src/modules/external-agents/application/external-agent-discovery.ts` — the two tiers
- `apps/api/src/services/runtime-client/runtime-client.ts` — the typed hub facade and event filter
- `apps/runtime/src/services/external-agents/` — adapter registry, session supervisor, output
  normalization, process framing and process-tree cleanup
- `apps/runtime/src/registry.ts` — method wiring, consent boundary and lifecycle close
- `apps/api/src/modules/external-agents/domain/adapter-descriptors.ts` — product declarations
- `apps/api/src/modules/external-agents/http/external-agent-routes.ts` — `GET /api/external-agents`

The selector does not poll. Environment state changes already publish a user-scoped invalidation
on the environments realtime topic, and that is exactly when these answers go stale.

## Capabilities

Capability flags are how an adapter refuses to fake parity. Nothing is true by default, and the
hub never declares one on an adapter's behalf — a hub-side table would disagree with a runtime of
a different version, and the runtime is the one that would actually run the turn.

| Flag                   | What it gates                                              |
| ---------------------- | ---------------------------------------------------------- |
| `structuredStreaming`  | Hosting the vendor at all; a text transcript is not enough |
| `reasoningStream`      | The reasoning panel                                        |
| `interactiveApprovals` | Approval prompts in the UI rather than a dead-ended TTY    |
| `resume`               | Continuing an existing vendor session                      |
| `modelCatalog`         | The model selector in the input bar                        |
| `images`               | Image attachments in the composer                          |
| `usageReporting`       | Per-turn token usage                                       |
| `cancellation`         | The stop button                                            |
| `steering`             | Sending a correction mid-turn rather than after it         |
| `sessionListing`       | Adopting a session started in a terminal                   |
| `nativeReview`         | The vendor's own review of uncommitted changes             |
| `accountUsage`         | Plan-level usage and rate limits                           |

## Permissions

Two orthogonal product axes:

- **Level** — `read-only`, `default`, `full-access`: what the agent may do.
- **Approval routing** — `user`, `auto-review`: who answers its prompts.

They are separate because in at least one vendor they genuinely are. Codex sets what the agent may
do with a sandbox plus an approval policy, while a separate field decides who reviews the prompts,
and that reviewer applies at *any* sandbox level. A flat list of four choices could not express
"read-only **and** auto-reviewed".

Roughly, per vendor:

```text
LEVEL         codex                          cursor (ACP)        claude
read-only     sandbox read-only              plan mode           plan
default       workspace-write + on-request   agent mode          the account's own default
full-access   full access + never ask        unsupported         bypass permissions

ROUTING       codex                          cursor (ACP)        claude
user          reviewer = user                permission request  default / manual
auto-review   reviewer = auto review         unsupported         auto, where the account allows it
```

But the axes are **not freely composable everywhere**: Cursor exposes a fixed set of session
modes, and Claude collapses both axes onto one flag whose values depend on plan tier, model and
organization policy. So the axes stay as the product vocabulary, and **each adapter returns the
combinations it actually supports**, each marked `supported`, `unattended`, and — where refused —
with a reason. The UI renders that list and nothing else; it never composes two independent
controls into a pair no adapter offered. That is what stops an impossible state from being
offered for a vendor whose two axes are really one.

Cursor is where "the adapter decides" stops being theoretical. Over ACP it has one control where
Codex has three — a session mode, changeable on a live session — and no reviewer field at all. Its
print mode has `--force` and `--auto-review`, and its own `cli-config.json` carries an approval
mode, but neither is reachable through the protocol. The only way to fake either would be to
auto-answer every permission request, which would make MangoStudio the thing granting the
permission. So both come back `supported: false` with a reason that says where the setting actually
lives, and **no code path answers a permission request on the user's behalf**.

Because the API union is closed while the columns that persist a choice are `TEXT`, the read path
normalizes an unrecognized stored value to the **restrictive** end — `read-only` and `user` — and
records that it did. A downgrade must never widen privilege.

## Workspace trust

Choosing a folder for a chat says where files live. For some vendors it also decides something
else: opening a Cursor ACP session against a directory makes the CLI load that directory's rules,
project configuration and MCP server definitions — instructions written by whoever wrote the
repository — and follow them. ACP offers no flag to decline it.

That is a decision about **executing third-party configuration**, so it is asked separately from
the vendor disclosure and recorded per `(user, environment, canonical workspace)`. The first turn
in an untrusted workspace is refused before the stream opens, with the canonical path the target
machine spells, and the client turns that refusal into one dialog and one retry. The grant covers
exactly that directory: a parent's grant does not cover a child.

Only vendors that have declared what they load are gated. Extending that list is how another
adapter opts in — a disclosure that cannot name what it covers is a dialog people learn to dismiss.

## Vendor text is bounded

Everything a vendor emits is text MangoStudio did not write, rendered in MangoStudio's UI and
stored in MangoStudio's database. It passes through untranslated and is rendered as **plain text,
never markdown or HTML**. Before an event is persisted or rendered, at the runtime boundary:

- C0 and C1 control characters are stripped, keeping only tab and newline.
- Bidirectional overrides and isolates are stripped — they let a label render in an order its code
  points do not have, which is how a benign-looking command hides what it will run.
- Each field is cut to an explicit **code-point** limit (128 for a tool name, 256 for a title,
  4096 for a detail, 2048 for an error message), never a UTF-16 cut that could split a surrogate
  pair, and the event is marked as truncated. A whole turn's persisted payload is bounded too: one
  in-bounds event says nothing about ten thousand of them.

The limits live in `apps/shared/src/external-agents/vendor-text.ts`.

The transcript keeps vendor prose in ordinary `text` and `thinking` parts, so a partial turn is
still readable everywhere a message is. What marks it as vendor-authored is the message itself:
an assistant message whose parts contain an `external_turn` record was produced by a vendor and
by nothing else, and **that record is the discriminator a renderer keys off** to hold the
plain-text rule above. There is no mixed message to disambiguate — a chat runs one kind of turn,
and a MangoStudio turn never writes an `external_turn` part.

## Credentials

MangoStudio never reads, stores, logs or transmits a credential value.

It **may** read a bounded, non-secret CLI config to test whether a key is present — Cursor
publishes sign-in state that way, and `probeConfigKey` in
`apps/shared/src/environments/detection/auth-signal.ts` does exactly that: a length-capped read, a
parse, one boolean out. The parsed value is never retained and no part of it reaches a result, a
log or a diagnostic. Credential *files*, by contrast, are stat-only: `probeAuthFile` never opens
one.

This is a fallback. All three vendors now answer authoritatively through their own status command,
and that path reads nothing.

Where a status call returns account identity, it is treated as personal data: only a minimal
display label crosses the wire, only to the user who owns the environment, never persisted into
chat history, and redacted in diagnostics and logs. Claude's status call returns an email, an
organization id and an organization name; none of them leave the runtime.

External agents are **unavailable by default** in any environment whose transport has not attested
an isolated OS identity and vendor credential home. Logical ownership of a `(userId,
environmentId)` pair is not an operating-system identity, and two users sharing one machine
account would share one vendor sign-in.

## Isolation

The whole model rests on the vendor owning authentication. That is only true if the vendor's
credentials belong to the person whose turn is running, so an environment has to **prove** it —
absence is default-deny, and there is no configuration flag that fabricates a proof.

The proof has two halves, in two places, because neither side can supply the other's.

The **runtime** attests what it can establish about itself, in
`apps/runtime/src/services/external-agents/isolation.ts`:

| Method             | What it means                                                          | Who makes it                                                 |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `single-user-host` | The hub process serves exactly one MangoStudio user on this OS account | The in-process connector, and a paired machine for its owner |
| `os-account`       | This process has its own uid and its own credential home               | ssh, wsl, and a hub-launched stdio runtime                   |
| `container`        | A container whose credential home is genuinely its own                 | Container environments                                       |

`container` is a *check*, not a label. Containerization alone proves nothing: a
`-v ~/.claude:/root/.claude` bind mount puts the host's vendor logins inside a container whose uid
namespace and filesystem both still say "isolated". So the mount table is read and any mount at the
credential home — or at `~/.claude`, `~/.codex`, `~/.cursor` and their XDG equivalents — withdraws
the attestation. A container whose mount table cannot be read attests nothing.

The attestation carries a `credentialHomeFingerprint`: a non-reversible digest of the credential
home's identity, never its contents and never a path that would leak a username. It exists so the
hub can notice that the identity behind a session changed.

The **hub** supplies the half a runtime cannot. From inside, a dedicated per-user SSH account and a
shared service account four people's keys land in are indistinguishable — same uid, same `$HOME`,
same everything. The hub is the only party that sees both the OS identity and which MangoStudio
user each connection belongs to, so
`apps/api/src/modules/external-agents/application/external-identity-isolation.ts` watches for one
fingerprint claimed by two users and withdraws the attestation from **both**.

Withdrawing from everyone, rather than keeping it for whoever arrived first, is deliberate. The
danger is not that the newcomer reaches the incumbent's `~/.claude`; it is that one vendor login
sits in that shared home and nobody can say whose it is, so the incumbent is as likely to be
spending the newcomer's subscription seat as their own. Once contested, a fingerprint stays
contested for the life of the process: a user closing a laptop does not un-share a credential home.
Sessions already running on a newly contested home are closed, because refusing only the next turn
would leave the thing just decided to be unaccountable still running.

**Discovery is cached; authorization is not.** Both paths consult the registry. A turn is refused
with `EXTERNAL_ISOLATION_UNPROVEN` even when a stale descriptor said otherwise, and the
`credentialHomeFingerprint` is part of a continuation's binding, so a resumed vendor session that
silently moved to a different OS identity starts fresh instead.

### What an operator does about it

The remedy is never in MangoStudio's settings — it is a change to the machine:

| Environment | What makes it eligible                                                    |
| ----------- | ------------------------------------------------------------------------- |
| Local       | Run the hub for a single MangoStudio user                                 |
| WSL         | A distinct WSL user account per MangoStudio user                          |
| SSH         | A per-user account on the remote host, not one shared login               |
| Container   | A container per user, with no mount exposing the host's agent credentials |
| Paired      | Pairing does not transfer credentials; a paired machine serves its owner  |

An operator override is deliberately **not** provided. If one is ever added it belongs in managed
configuration with an audit record, not a runtime environment variable — the point is that the
attestation cannot be asserted by the party that benefits from asserting it.

## Third-party ownership

Every external agent is another company's software, running under its own terms, billed to its own
account. The disclosure that says so is a **precondition the hub enforces**, not a modal the
browser decides to show: a gate only one client honors is a courtesy, and the external API sends
the same conversation to the same company.

| Target   | Company   | Owns auth | Owns billing | Owns tools & permissions |
| -------- | --------- | --------- | ------------ | ------------------------ |
| `codex`  | OpenAI    | Yes       | Yes          | Yes                      |
| `cursor` | Anysphere | Yes       | Yes          | Yes                      |
| `claude` | Anthropic | Yes       | Yes          | Yes                      |

Vendor names, terms URLs and privacy-policy URLs are **data**, in
`apps/shared/src/external-agents/vendors.ts` — not translated strings, because a localized URL is a
different URL and a paraphrased term of service is MangoStudio making a claim about obligations
that are not its to state. Branding is nominative use only: the name identifies the tool being
launched, with no logos, no wordmarks and nothing implying an endorsed or partner integration.

An acknowledgement is recorded per `(user, vendor)` and goes stale on any of three things: the
disclosure text version, the vendor's declared capability set, and **the resolved effective
permission default**. The third is why the record carries a context fingerprint rather than a
boolean. Claude Code's default permission mode moves from `manual` to `auto` for Pro, Max and Team
accounts on 2026-08-14; nothing about MangoStudio changes and no capability flag changes, but what
runs without asking goes from "reads only" to "everything, with a classifier reviewing each
action". Consent given for the first must not silently cover the second.

Revoking blocks new starts and closes live sessions, so withdrawing never leaves a vendor process
running that the owner has just refused. No configuration flag or environment variable satisfies
the gate.

### The `~/.claude` inheritance limit

Claude Code is hosted **without** `--bare`, which means a MangoStudio turn loads the same context an
interactive session would: hooks, skills, plugins, MCP servers, auto memory and `CLAUDE.md` from the
working directory and from the runtime host's own `~/.claude`. A hook or MCP server configured on
that machine, outside MangoStudio, executes inside a MangoStudio turn.

This is not an oversight, and it is not fixable **for this adapter**. `--bare` skips all of it, but
bare mode never reads OAuth credentials or the system keychain: it authenticates from
`ANTHROPIC_API_KEY`, from an `apiKeyHelper` supplied through `--settings`, or from a third-party
provider's own credentials (Bedrock, Vertex, Foundry). None of those is the subscription sign-in this
adapter hosts, so for a subscription-backed account determinism and authentication are mutually
exclusive, and v1 takes authentication. The disclosure states the inheritance rather than papering
over it.

Two consequences for the drift work in plan 010: the vendor documents that `--bare` "will become the
default for `-p` in a future release", which would break subscription-backed turns without warning,
and `system/init.plugins`, `plugin_errors`, `mcp_servers` and `mcp_server_errors` are the fields
that reveal what actually loaded.

## Hosting a turn

An external turn takes the same SSE transport as an internal one — same framing, same keepalive,
same `done` terminator — because the client renders one chat. Only the producer differs. The
streaming route branches on the chat's runner **before** the model, agent and provider preflight:
an external turn resolves no MangoStudio model, and running that preflight first would answer a
chat that needs no model with `NoModelAvailableError`.

The wire vocabulary is a parallel set of `external_*` chunks rather than a reuse of `text`,
`tool_call_started` or `mcp_elicitation_request`. Those carry MangoStudio's own assumptions — a
tool the executor can re-run, an elicitation its MCP client owns — and a vendor's output entering
any of them is the failure this whole context exists to prevent.

The projection from a neutral event to a chunk lives in `apps/shared/src/streaming/external-events.ts`.
The hub builds the durable transcript from the *same* events, through a second projection —
`ExternalTurnTranscript` — so there are two of them, not one: the live render and the reloaded one
each have their own path from the same source. `apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts`
drives both from one event sequence and compares the results, which is what keeps them from
disagreeing.

`external_turn_completed` carries the terminal reason. The vendor's own `completed` and `error` are
two of nine ways a turn ends and the hub decides the other seven, so without it a live view could
only ever show two outcomes and a reload would replace them with a third.

## Deliberately out of scope

Present in a vendor's contract, not surfaced. Named here so a later cycle finds them without
protocol archaeology:

- **Codex service tiers.** `model/list` reports `serviceTiers` per model. Nothing renders or sends
  one; the account's own default applies.
- **Codex personality / collaboration modes.** Reachable through the app-server, not exposed.
- **Multi-root workspaces.** `thread/start` accepts several roots and `workspaceWrite` accepts
  several `writableRoots`. A chat has one workdir, so exactly one root is sent.
- **`AskForApproval`'s granular object.** The neutral levels use the coarse policy. The granular
  form (`mcp_elicitations`, `rules`, `sandbox_approval`, and the optional `request_permissions` and
  `skill_approval`) is where a finer-grained mode would go.
- **Attachments.** `ExternalAgentAttachment` crosses the protocol, but the composer does not yet
  offer images to an external runner.
- **Claude's `--permission-prompt-tool`.** It exists and is documented, and it is the only way
  headless Claude could deliver an answerable approval. Hosting one makes MangoStudio part of the
  authorization path for an agent it does not own, which needs authenticated request ids, replay
  protection, expiry, owner binding, fail-closed behaviour and a threat model — its own security
  feature, not a flag in an adapter.
- **Claude's `--safe-mode`.** Disables the machine's own hooks, plugins, MCP servers and `CLAUDE.md`
  while auth, model selection and permissions keep working. It would close the inheritance limit
  above, at the cost of silently dropping the project memory and skills a workspace depends on, so
  it belongs behind a visible per-chat control rather than as an invisible default.
- **Claude session browsing.** The internal JSONL lives under an encoded `~/.claude/projects/<cwd>/`
  path the vendor documents as subject to change. Parsing it would be reading a private format.

## Availability

Discovery reports each target on its own merits — installed, signed out, unreachable, isolation
unproven — and the blanket `not-yet-available` gate is gone. It existed while hosting a turn
arrived in stages, because a selectable runner that could block on an approval nobody can answer is
worse than no runner at all. Its removal was the release-unit boundary.
