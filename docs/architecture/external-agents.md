# External Agents

An **external agent** is a vendor CLI — Codex, Cursor, Claude Code — that MangoStudio hosts
rather than reimplements. When one runs a turn, the vendor owns everything that matters:
authentication, model choice, context, tools, permissions, sandboxing, approvals and its own
session state. MangoStudio discovers the CLI in the user's selected environment, spawns it
through the runtime, relays input, renders normalized events, forwards approvals, and cancels.
Nothing more.

**Cursor is external-only.** It was briefly reachable both ways — here, and as a
MangoStudio-owned provider that picked the model, declared the tools, executed them and enforced
permissions. Those are opposite ownership models, and one vendor answering to both in one selector
is how a tool ends up executed by whichever side assumed the other owned it. The provider is
deprecated and refuses every turn; [`../providers/cursor.md`](../providers/cursor.md) records why
and what a chat still carrying a `cursor/*` model does.

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
canonical directory paths and asks its host to authorize each one. It asks at open, for every extra
root, and for a workspace-scoped session listing. Every host applies one policy: a workspace is
authorized only when a chat owned by the connection's user, on the connection's environment,
already stores that exact canonical `workdir`. The CLI/setup stand-in user `local` and a connection
with no bound user are never authorized.

The stored `workdir` is the runtime's own canonical path. `workspace.validate` returns, as
`resolvedPath`, the directory canonicalized by the same function the runtime's external-agent
authorization uses (`canonicalize` in the Rust runtime), and
the hub stores that value. A workdir chosen through a symlink, or with different casing on a
case-insensitive filesystem, is therefore stored in the form the authorization later asks about.
Workdirs stored before this rule keep their lexical form until the user selects them again; the
hub cannot canonicalize them itself because the path belongs to the runtime's filesystem.

Every Rust runtime — Local, which the hub spawns as the `mangostudio-runtime` binary, and stdio,
WSL, SSH, container, HTTP or dial-in — asks back over its own hub session; Local's session is bound
to `{ userId, environmentId: 'local' }`. It
sends `hub.workspace.authorize` from the hub-served `mangostudio.hub` contract
(`apps/shared/src/runtime-contract/hub-contract.ts`, emitted as `generated/hub-catalog.json`) with
`{ canonicalPath, purpose: "external-agent" }`. The hub binds each session to the `(userId,
environmentId)` it recorded when it opened the connection. For a dial-in, that is the verified
pairing credential's own user and environment. The runtime never names a user. The hub validates
the params against the closed schema and refuses a mismatch with `INVALID_PARAMS`.

The Rust runtime validates the question and the answer against the embedded hub catalog. It
admits a workspace only on an explicit `{ "authorized": true }`, with a 5 s bound. A timeout, an
error, a closed session, a malformed result or a path the schema refuses is a denial. So is
`METHOD_UNSUPPORTED` from an older hub. That is also why the hub does not advertise the method in
its hello: a hub that cannot answer already fails closed. Hosts without an authorization source
deny every workspace.

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
- `crates/mangostudio-runtime/src/external_agents/` — the runtime host over the External Agents
  SDK: session supervisor, authorized launch, isolation and the mapper to the wire (see
  [The Rust runtime host](#the-rust-runtime-host))
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

Most are constants per adapter, decided by what the vendor's protocol offers. `modelCatalog` is the
exception and is decided **per install**: Claude publishes its model aliases in `--model`'s own
description, so a build that states them has a catalog and one that does not keeps the picker
hidden exactly as before. It is derived once and reported identically by `discover` and
`openSession` — a session that disagreed with the descriptor it was chosen from would offer a
picker the hub never validated a model against.

## Slash commands

Every vendor expands `/name` at the head of a prompt, in the exact non-interactive mode its adapter
uses — verified against live binaries, not inferred from the fact that a terminal does it. Nothing
in the prompt path escapes, wraps or rewrites a leading slash, and nothing needs to: the text
arrives as the user typed it and the CLI resolves the name against directories it read itself.

Two of them also *announce* what they will expand, and the adapter forwards that as
`commands_available`:

| Target | Where the catalog comes from                        | When                         | Descriptions |
| ------ | --------------------------------------------------- | ---------------------------- | ------------ |
| Cursor | ACP `available_commands_update`                     | Once, when the session opens | Yes          |
| Claude | `system/init`'s `slash_commands`                    | At the head of every run     | No           |
| Codex  | Nothing on the wire; custom prompts are client-side | —                            | —            |

The catalog is **a hint, not an allowlist**. A command file written after a Cursor session opened
still expands when typed and never appears in that session's list, so nothing refuses a name it has
not seen — the list exists to help a user find a command, not to gate one. Claude Code is exempt
from that staleness by construction: it is spawned again for every turn and re-reads its command
directories each time, which is also why the same event arrives once per run rather than once per
session.

Only two kinds of announced name are withheld, both on the vendor's own say-so: the ones Claude
Code marks `terminal_slash_commands`, which need the interactive terminal the adapter does not
give it, and its `__`-prefixed internals. Whether `/compact` behaves the same under `--print` as it
does in the REPL is the vendor's answer to give, so a hand-maintained list of "commands we think
are interactive" is not kept.

That makes `terminal_slash_commands` load-bearing, and it is **newer than the oldest Claude build
the adapter supports** (`2.1.211`). A run that does not state the list — because it answered with a
scalar, or because it predates the field, as the recorded `2.1.226` fixture does while still
announcing `doctor` and `color` — gets **no catalog at all** rather than one that quietly publishes
names needing a terminal. The composer falls back to the library scan there, the same way it does
before a target's first turn.

Codex has no catalog to send, and the composer falls back to the library's scan of
`~/.codex/prompts` for it — which is the same fallback every target uses before its first turn.
Giving MangoStudio's own runner real commands is [#961](https://github.com/juliopolycarpo/mangostudio/issues/961);
until then `/name` reaches a native chat as a request for the skill of that name, advertised in the
`<available-skills>` section rather than expanded by a loader.

## Permissions

Two orthogonal product axes:

- **Level** — `read-only`, `default`, `full-access`: what the agent may do.
- **Approval routing** — `user`, `auto-review`: who answers its prompts.

They are separate because in at least one vendor they genuinely are. Codex sets what the agent may
do with a sandbox plus an approval policy, while a separate field decides who reviews the prompts,
and that reviewer applies at *any* sandbox level. A flat list of four choices could not express
"read-only **and** auto-reviewed".

### Presets

Two axes is an honest model of what the vendors offer and also two questions a non-expert did not
ask. Crossed, they are six cells — three of which no vendor offers and one of which is dangerous —
while the user's actual question is how much the agent should bother them. Three named presets
answer that, and the matrix moves behind an "Advanced" disclosure in the same panel rather than
away: it is what anyone who wants the axes reaches for, and what a stored custom pair is edited
with.

| Preset       | Candidates, in order                               |
| ------------ | -------------------------------------------------- |
| `careful`    | `read-only × user`                                 |
| `balanced`   | `default × user`                                   |
| `autonomous` | `full-access × user`, then `default × auto-review` |

A preset is a list of pairs, not one pair, because the same preset is not the same pair everywhere:
Claude's `auto-review` is an account-gated classifier and Codex's is a sandbox. The first candidate
the descriptor reports `supported` wins, and `autonomous` leads with `full-access × user` precisely
because both its candidates are unattended and only the first is expressible on every vendor.

A preset with no supported candidate is **not offered** rather than offered and refused: a control
that cannot work reads as a MangoStudio fault instead of as something this vendor does not do. The
matrix opens expanded when the stored pair matches no preset, so a user who already chose a custom
combination is not told it vanished.

The unattended warning follows the axis the preset *resolved* to, not the preset. `autonomous`
falling back to `default × auto-review` cannot leave the workspace, so the level warning would be
false there — the true statement is that its approvals are answered without the user.

### Who answers a Claude prompt

Nobody, and Claude is now told so. `--permission-prompts none` is on every turn's argv for a build
that declares the flag (2.1.259+), because `interactiveApprovals` is false for this target and a
prompt has nowhere to go — see **Deliberately out of scope** for why the control channel is not
reachable.

This is pinning rather than a fix. On 2.1.260, with the flag's default of `host` and stdin closed
after the prompt, an unmatched `Write` under `--permission-mode default` already produces
`system/permission_denied`, a `tool_result` marked in error, exit 0 and no file. Nothing hangs.
What the flag buys is that the property survives another default change: a future build honouring
`host` by *waiting* would park every approval-needing turn until the idle timeout.

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
stored in MangoStudio's database. It passes through untranslated. Before an event is persisted or
rendered, at the runtime boundary:

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
by nothing else. There is no mixed message to disambiguate — a chat runs one kind of turn, and a
MangoStudio turn never writes an `external_turn` part.

Vendor prose renders **as markdown, through the same renderer as a MangoStudio turn's**. A vendor
writes markdown because it assumes a terminal renders it, so rendering it literally showed `##`
and `**` raw rather than hiding anything. The safety property is not the caller's choice of
renderer, it is what the renderer emits: `MarkdownContentRenderer` escapes raw HTML instead of
parsing it, resolves every link and image target through a scheme allowlist
(`http`/`https`/`mailto`, everything else becomes `#`), escapes link *label* text so markup cannot
be smuggled past a safe href, and downgrades an image to an anchor so no vendor-named URL is ever
fetched. A renderer that leaked any of those would leak them for MangoStudio's own model output
too — which is equally model-written — so the boundary belongs there and not at a per-caller flag.

## Credentials

MangoStudio never reads, stores, logs or transmits a credential value.

It **may** read a bounded, non-secret CLI config to test whether a key is present — Cursor
publishes sign-in state that way, and `probe_config_key` in
`crates/mangostudio-runtime/src/probing/detection/auth_signal.rs` does exactly that: a length-capped read, a
parse, one boolean out. The parsed value is never retained and no part of it reaches a result, a
log or a diagnostic. Credential *files*, by contrast, are stat-only: `probe_auth_file` never opens
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
`crates/mangostudio-runtime/src/external_agents/isolation.rs`:

| Method             | What it means                                                          | Who makes it                                      |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `single-user-host` | The hub process serves exactly one MangoStudio user on this OS account | A paired machine for its owner                    |
| `os-account`       | This process has its own uid and its own credential home               | Local, ssh, wsl, and a hub-launched stdio runtime |
| `container`        | A container whose credential home is genuinely its own                 | Container environments                            |

`container` is a *check*, not a label. Containerization alone proves nothing: a
`-v ~/.claude:/root/.claude` bind mount puts the host's vendor logins inside a container whose uid
namespace and filesystem both still say "isolated". So the mount table is read and any mount at the
credential home — or at `~/.claude`, `~/.codex`, `~/.cursor` and their XDG equivalents — withdraws
the attestation. A container whose mount table cannot be read attests nothing.

The attestation carries a `credentialHomeFingerprint`: a non-reversible digest of the credential
home's identity, never its contents and never a path that would leak a username. It exists so the
hub can notice that the identity behind a session changed.

Every attestation is derived by the process making it, from its own credential home — including
Local's. Local used to run inside the hub and report `single-user-host`; it is now a spawned Rust
runtime that reports `os-account` for the same home. What made Local's claim single-user is still
the hub's: `createLocalRuntimeConnector` binds the OS credential home to one MangoStudio user,
announces `externalAgentIsolation: "withdrawn"` once a second owner appears (closing every
attested Local connection first), and never attests the `local` stand-in. The runtime reads that
claim from the hub's `hello` and omits its attestation from `runtime.health`, and the hub strips it
from the manifest.

The **hub** supplies the half a runtime cannot. From inside, a dedicated per-user SSH account and a
shared service account four people's keys land in are indistinguishable — same uid, same `$HOME`,
same everything. The hub is the only party that sees both the OS identity and which MangoStudio
user each connection belongs to, so
`apps/api/src/modules/external-agents/application/external-identity-isolation.ts` watches for one
fingerprint claimed by two users and withdraws the attestation from **both**.

That half travels on the wire. The hub announces `externalAgentIsolation: 'single-user' |
'withdrawn'` in its `hello.capabilities` — beside `hub`, not inside it, because the hub identity
object refuses unknown members and an older runtime would discard the whole thing — and the runtime
stops attesting when it hears a withdrawal. It is announced rather than passed at spawn because
most runtimes are not spawned by the hub at all, and because a claim frozen into an argv could not
be revoked without restarting a machine the hub does not own.

The two hellos cross: a session sends its own from its constructor, so the manifest the runtime
announced was composed before it could read the hub's refusal. The withdrawal is therefore applied
on both sides — the hub withholds `identityIsolation` from the manifest it accepts, since it
already knows what it refused, and the runtime honours the refusal from its next answer onward,
which is what `runtime.health` and a refreshed manifest report. The hub retains its claim on the
connection and applies the same withdrawal rule to every manifest replacement, so an older peer
that repeats its attestation in health cannot restore it. Discovery and environment status both
read the accepted manifest.

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

Two of those three materials come from the **adapter that would run the turn**, so the fingerprint
is only ever compared against an adapter's answer. The cheap discovery pass reports every capability
false and no effective default — it looked for a binary, it never asked what the binary would do —
and treating that placeholder as a finding made an ordinary cold cache indistinguishable from a
vendor that had changed. A reload, a sign-in or a runtime reconnect drops the discovery cache, so
the notice came back on every one of them for consent nobody had withdrawn. Unknown is therefore not
stale: with no adapter answer the row is still checked for existence and for the current text
version, and nothing else. For the same reason the acknowledgement endpoint is the one discovery
caller that **waits** for the authoritative pass — a selector render may serve a placeholder for a
few seconds, a consent record may never store one.

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

## Steering

Codex only. `turn/steer` is a first-class client operation in Codex's own protocol — the user
sends more input into a turn that is still running, and the vendor redirects rather than queuing
it behind the current work. Cursor and Claude have no equivalent: a second message to either is a
new turn, or dies with no owner to answer it. Composing "steering" on top of that would give the
same button two different meanings depending on which vendor happened to be selected, so the
capability flag comes from whether the adapter implements the optional `steer` member, and the
composer reads it from there rather than assuming.

The composer gates the affordance on the adapter's static capability alone. Codex's own protocol
gives no advance signal that a specific in-flight turn will refuse a steer; `Turn` carries no such
field. So a refusal is discovered by attempting it, not predicted before the button is shown, and
`turn-not-steerable` is what a rejected attempt reports back. The one exception is a turn
MangoStudio itself started as a review: nobody has to ask Codex about a turn the hub knows the kind
of, so both the hub and the adapter answer `turn-not-steerable` locally, before the durable record
a steer would otherwise leave behind.

**Persistence order is the whole feature.** The hub writes the steered text into the running
turn's transcript — optimistically, as accepted — *before* calling the runtime, not after. A vendor
call that succeeds but whose acknowledgement is lost must never make the user's own words
disappear from what they see on reload; writing first and correcting the record in place on an
actual rejection is what keeps that true. The five rejection reasons —
`turn-already-completed | not-supported | session-lost | turn-not-steerable | id-reused` — are
answered from cheapest to most expensive: a missing live turn, a session's own capabilities, a
stale `nativeTurnId`, and a `clientMessageId` reused with different text are all decided by the hub
without a runtime round trip; only Codex's own turn state needs one.

That same durable write is charged against the turn's byte and event budget, exactly like a vendor
event — a steer is up to 1 MiB and the caller may attempt as many as it likes, so without a charge
it would be a second, uncapped way to grow the message `EXTERNAL_TURN_PAYLOAD_MAX_BYTES` exists to
bound. The attempt that crosses the line is kept, matching how the same budget treats a vendor
event, but the turn ends there: no further steer, and no further vendor event, follows it.

Live delivery holds an `onEvent` notification back if it arrives while an already-durable steer's
outcome has not been reported yet, and releases it right after that report — a live listener would
otherwise see the vendor event before the steer that, in the durable transcript, came first. A
steer's own runtime acknowledgement is not part of what a turn's terminal path waits on
indefinitely, either: `terminate` gives it a few seconds to land and correct the record in place,
but an unresponsive one no longer keeps Stop, or the vendor's own completion, waiting for it.

The Codex adapter refuses locally, before any request, when an approval is currently outstanding on
the same turn. The shared JSON-RPC client answers one message at a time and does not read past an
unanswered server→client request, so a `turn/steer` sent into that window could never see its own
response — the adapter reports `turn-not-steerable` instead of leaving the caller to hit the
request's own timeout.

## Adopting a session started outside MangoStudio

Both Codex and Cursor keep their own conversation history, and the people who use this feature are
by definition already terminal users. The common shape is: start something in a terminal, get deep
into it, then want the transcript, the approval UI and the persistence MangoStudio provides.
Adoption is what makes that possible without re-explaining everything.

**Adoption is a pointer, not an import.** MangoStudio does not copy the vendor's transcript into
its own message table. The chat opens with a marker part saying it continues a native session, and
turns from that point stream and persist normally. Two reasons: the vendor owns that history, and
duplicating it creates two divergent copies of one conversation; and the vendor's transcript is not
in MangoStudio's part format, so importing means a lossy translation nobody asked for.

**Codex and Cursor only.** Codex has structured, paginated `thread/list`; Cursor advertises
`sessionCapabilities.list` and answers `session/list` with cwd filtering. Claude Code has no
usable listing — its history is internal JSONL under an encoded `~/.claude/projects/<cwd>/` path
that the vendor's own documentation calls internal and subject to change — so its picker entry says
that, rather than implying something is missing. "Continue the most recent session" is not offered
as a substitute: it is race-prone against a session the user is actively driving in another
terminal, and it can pick up the wrong workspace or the wrong vendor account. Omitting the vendor
beats guessing which conversation somebody meant.

The two listings differ more than a neutral schema suggests, and the differences are where the bugs
live:

- Codex's `Thread.id` is the thread; `Thread.sessionId` is a *different* required field naming the
  whole thread tree. `thread/resume` takes the first. Its `name` is nullable and `preview` — "usually
  the first user message" — is required, so a null title falls back to the preview. Timestamps are
  Unix **seconds**. `turns` is documented as empty at list time and there is no `messageCount`
  field, so nothing derives a message count. Ephemeral threads and anything with a
  `parentThreadId` are excluded, and `sourceKinds` is always an explicit allowlist — five of the
  ten kinds are Codex's own subagent, review and compaction threads.
- Cursor's rows are `sessionId`, `cwd` and an **ISO-8601** `updatedAt`, with no title of any kind.
  Its rows render as workspace plus age, and nothing synthesizes a title to fill the gap.

`updatedAtMs` is normalized once, at the runtime boundary, so no consumer sees a vendor's native
time format.

Three properties adoption needs beyond the listing itself:

- **Re-read at adoption.** A listing proves a session existed when the page rendered. Adoption
  re-reads the exact metadata — id, cwd, updated time — and refuses if it changed or vanished. A
  picker row is a hint, not a handle, and a session written to since the picker loaded is one
  somebody is using right now.
- **Adopt strictly.** The ordinary turn path resumes with `resumeMode: 'fallback'`, which is right
  for a send and wrong for adoption: a user who chose a specific conversation must not silently get
  an empty one. The continuation row carries `pendingAdoption` until the vendor confirms the
  resume, and that flag is what makes the first open strict.
- **Take a lease.** Two MangoStudio chats must not attach to one native session concurrently. The
  lease is keyed by `(environmentId, targetId, nativeSessionId)` with an owner and an expiry,
  refreshed while the chat keeps opening sessions and released when its continuation is dropped. It
  cannot see the user's own terminal — nothing on the hub can — but it makes the half MangoStudio
  owns single-writer, and gives adoption somewhere to refuse rather than a race to lose.

Listing is guarded exactly like a turn, with one addition: without an isolation attestation it is
not offered at all. Showing another OS user's conversation titles is a worse disclosure than
sharing a credential.

## Reviewing the working tree

Codex only. `review/start` is a first-class non-interactive review in Codex's own protocol, with
`enteredReviewMode` / `exitedReviewMode` items bracketing it — a product feature, not a prompt
template, and the `nativeReview` capability comes from whether the adapter implements the optional
`startReview` member.

**It is not auto-review.** The permissions dropdown's `auto-review` routing decides whether a
subagent answers the *agent's own tool calls*; this reviews the *user's code*. Same word, opposite
subjects, so each surface's copy states its subject explicitly and the two never appear adjacent:
the action lives in the repository panel, next to the changes it reviews.

One target ships, `{ type: 'uncommittedChanges' }`, modelled as a discriminated union with a single
member so Codex's `baseBranch`, `commit` and `custom` are additive later rather than a breaking
reshape of a string enum. Delivery is always `inline`, and `ReviewStartResponse.reviewThreadId` is
**asserted** to be the session's own thread rather than assumed: detached delivery runs the review
on a thread nothing is subscribed to, so a build that returns another id fails the call instead of
streaming into the void.

A review is a turn that happens to be a review. It uses the same session, the same active-turn
rule, the same `clientMessageId` idempotency, the same event topic and sequence, the same
persistence and the same cancellation — the bracketing items render as ordinary `kind: 'review'`
activity and the verdict as ordinary assistant text, so no second event vocabulary exists. Two
things differ: the vendor call is awaited, because only its response names the thread; and the turn
reports `turn-not-steerable` without a round trip, both in the adapter and in the hub, because
steering a review has no coherent meaning.

**Permissions stay with the thread.** Ordinary turns send the current sandbox, approval policy and
model on every `turn/start`. A review does not: Codex `review/start` has no equivalent fields, and
reopening the session to apply a newer pair would bypass the policy this conversation already
runs under. A permission change takes effect on the next send, not on a review of the working
tree that is already in this chat.

**The Git precondition is MangoStudio's own.** Codex does not refuse a review in a non-Git
directory — it completes, logging `fatal: not a git repository` internally, having reviewed
nothing — so the hub enforces it, and `EXTERNAL_REVIEW_REQUIRES_GIT` is what the UI renders. It is
checked **through the selected runtime**, never against the hub's filesystem: the workspace may be
on an SSH host, in a container, in WSL or on a paired machine, and a hub-side `fs` check would be
answering a question about the wrong disk.

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
- **Claude's interactive approvals.** Claude Code has a real bidirectional control channel —
  `control_request` / `control_response`, with a `can_use_tool` subtype whose shapes the binary
  documents itself — and it is **not reachable from a host like this one**. Probed against 2.1.260
  on 2026-09-04: the routing decision is a single function, and the "an SDK host answers" branch is
  reachable only when `--sdk-url` is set, which the CLI allowlists to Anthropic's own backend
  (`--sdk-url rejected: … reserved for Remote Control worker processes`). Sending an `initialize`
  control request first — which the CLI answers in full over plain stdio — does not unlock it
  either.

  So a Claude turn that needs permission is denied by the vendor and reported, and
  `--permission-prompts none` states that outright rather than relying on a default that has
  already changed once. See **Permissions** below.

  The one remaining public route is `--permission-prompt-tool`, and it stays out of scope on two
  counts. It takes an **MCP tool**, so serving it would make MangoStudio part of the authorization
  path for an agent it does not own — authenticated request ids, replay protection, expiry, owner
  binding, fail-closed behaviour and a threat model, i.e. its own security feature rather than a
  flag in an adapter. It is also absent from printed `--help`, so no capability could honestly be
  derived by probing for it.
- **Claude's `--safe-mode`.** Disables the machine's own hooks, plugins, MCP servers and `CLAUDE.md`
  while auth, model selection and permissions keep working. It would close the inheritance limit
  above, at the cost of silently dropping the project memory and skills a workspace depends on, so
  it belongs behind a visible per-chat control rather than as an invisible default.
- **Claude session browsing.** The internal JSONL lives under an encoded `~/.claude/projects/<cwd>/`
  path the vendor documents as subject to change. Parsing it would be reading a private format.
- **Queuing a follow-up message for Cursor or Claude.** Sending input to either while a turn is
  running starts a new turn or has no owner to answer it — the model already working never sees
  it. That is a different product promise from steering ("redirects what is running now") and
  deserves its own name and its own copy, not the same button doing two things depending on the
  vendor.

## Availability

Discovery reports each target on its own merits — installed, signed out, unreachable, isolation
unproven — and the blanket `not-yet-available` gate is gone. It existed while hosting a turn
arrived in stages, because a selectable runner that could block on an approval nobody can answer is
worse than no runner at all. Its removal was the release-unit boundary.

`installed-but-unusable` is the one reason no adapter reports. It is inferred hub-side from a
matrix an adapter *did* answer with: every adapter already states, per cell, why that cell is
refused, and this is what "every cell" adds up to. An **empty** matrix is a cold cache rather than
a finding, so it does not trigger it — reading one as a verdict would grey out a working target on
the first render after a restart.

### Remedies

A reason is a diagnosis. Every reason therefore carries a **remedy**: the next step, named as
something the interface can render as a control rather than as prose.

| Reason                    | Remedy              | What the user sees                               |
| ------------------------- | ------------------- | ------------------------------------------------ |
| `not-installed`           | `install`           | A link into `/environments/agents`               |
| `version-unsupported`     | `update`            | The same link; the recipes live there            |
| `signed-out`              | `sign-in`           | The vendor's own command, with a copy button     |
| `disclosure-required`     | `accept-disclosure` | The dialog that is already reachable             |
| `runtime-denied`          | `contact-admin`     | Who to ask                                       |
| `environment-unreachable` | `contact-admin`     | Who to ask                                       |
| `isolation-unproven`      | `contact-admin`     | Who to ask, plus the transport-specific guidance |
| `installed-but-unusable`  | `contact-admin`     | Who to ask                                       |
| `runtime-unsupported`     | `none`              | Nothing — the *runtime* lacks the adapter        |

The map is `satisfies Record<ExternalAgentUnavailableReason, ExternalAgentRemedyKind>`, so a reason
added later cannot ship without someone deciding what to do about it. That is why it is data rather
than a `switch` at each render site: three call sites each falling through to "no action" is how a
new reason silently becomes a dead end.

The refusal a *send* produces carries the reason as a field rather than interpolated into an English
sentence. `version-unsupported` is developer vocabulary; the client translates it from the catalog
it already has, and the English message stays as the fallback an External API consumer sees when it
renders nothing itself.

## Vendor pinning and drift

Every vendor surface an adapter depends on is **pinned, committed and diffed**, so a vendor upgrade
breaks a CI job rather than a user's turn. Three of the load-bearing facts here live on surfaces
that can move without notice: `codex app-server` is labelled `[experimental]` in its own help text,
`cursor-agent acp` is officially documented but **absent from `cursor-agent --help`**, and Claude's
permission modes changed meaning during the cycle that introduced them.

### Where the pins and the drift watch live

The vendor protocols moved to the External Agents SDK, and their pins went with them. The
recorded vendor contracts (Codex's generated API, the normalized Cursor ACP handshake, Claude's
declared flags and `auth status` shape) and the tooling that regenerates them live in the SDK
repository, [juliopolycarpo/mango-external-agents](https://github.com/juliopolycarpo/mango-external-agents).
Its "Vendor contract drift" workflow watches Claude and Codex (and OpenCode's ACP) in CI. Cursor's
ACP capture is recorded by hand, so its pin changes only when someone re-records it. This
repository consumes the SDK crates at an exact version and records no vendor contract of its own.

### The runtime half

CI catches drift on a maintainer's machine; users run whatever they have. Each adapter therefore
verifies its own assumptions at **discovery time**, and the answer is cached with the discovery
cache rather than paid per selector render.

| Vendor | Probe                                                                           | On mismatch                                                                                |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| codex  | `codex --version` against the pin                                               | `version-unsupported`, with the required version                                           |
| cursor | `cursor-agent acp` answers `protocolVersion: 1` with the keys the reducer reads | unavailable; **never a silent fall back to print mode**                                    |
| claude | `claude --help` declares every flag the turn's argv names                       | `version-unsupported`; a missing *mode* makes only the combinations needing it unsupported |

A version number alone never makes a target unavailable where a probe can answer instead. The pin
records what was verified, and a build older than it whose surface is intact keeps working —
enforcing the number would grey out working installs every time a pin went stale, which is the
failure the drift job exists to make unnecessary. Codex is the exception, and for a stated reason:
its `initialize` carries no protocol version and the calls discovery makes cover none of the turn
surface, so there is nothing to ask that would prove more than the pin does.

The same asymmetry applies here. An **unexpected but additive** handshake result — a new capability
key, an unknown mode — is tolerated and logged. A **missing** expected capability is what makes a
target unavailable.

## The Rust runtime host

`crates/mangostudio-runtime/src/external_agents/` hosts the same ten methods over the published
External Agents SDK (`mango-external-agents`, `mango-agent-claude`, `mango-agent-codex` and
`mango-agent-acp`, pinned exactly at 0.3.0). The SDK owns vendor protocols, harness lifecycle and
the idle-turn bound; the runtime owns authorized launch, scratch, consent, the session cap, the
per-turn payload budget and hard deadline, and the one mapper from SDK types to this wire.

These product facts come from SDK surfaces that `dyn Harness` alone does not cover:

- **Codex account fingerprint.** Discovery goes through `HarnessFactory::discover`, which the
  product factory overrides so Codex runs `CodexHarness::discover_with_account`. The key is
  `host_local_digest_key`'s hex text as bytes, read again for every Codex discovery, so
  `account.fingerprint` is the value `codex/adapter.ts` stored on continuations, and
  `account.planType` comes with it. The email is only the HMAC input inside the SDK. When the home
  cannot be read, discovery runs under a fixed plan-only key and drops its fingerprint: the plan
  still arrives and no fingerprint is sent.
- **Account limits.** `credits`, `spendControl` and `resetCredits` are relayed with times in
  epoch milliseconds and at most 64 reset-credit rows. Per-limit buckets and `reachedType` have
  no SDK source and stay absent.
- **Progress.** Codex command, MCP and patch progress arrive as coalesced `activity_updated`
  events, at most one per 5 s per activity, each with up to the last 2,000 characters. The bound
  is on characters, not bytes. One activity with mostly ASCII output fits the payload budget for
  the whole one-hour hard deadline (about 1.6 MB for 720 updates). Output that is mostly non-ASCII
  or JSON-escaped, or several activities streaming at once, can reach the limit sooner. At the limit the runtime ends the turn with its own
  `adapter-stream` error ("External-agent turn exceeded its persisted payload limit.") and cancels
  the vendor turn.
- **Turn endings.** A turn the SDK ends for silence, or for a lapsed approval, arrives as
  `Cancelled { reason: Timeout }`. The runtime reports it as an `adapter-stream` error, "External-agent
  turn exceeded its idle timeout.", as the TypeScript supervisor did, not as a bare `cancelled`.
  An ACP turn stopped at `max_tokens`, `max_turn_requests` or `refusal` ends with an `error`
  whose code is `vendor-turn-incomplete` and whose `vendorCode` is the stop reason. The turn
  footer shows the code and the message.

### Method map

| Method                                 | Rust handler                            | Most discriminating Rust tests                                                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external-agent.discover`              | `supervisor.rs` `discover`              | `discovery_omits_a_failing_target_and_keeps_the_rest`, `a_stalled_probe_costs_only_its_own_target_and_is_told_to_stop`, `codex_discovery_sends_the_fingerprint_the_typescript_adapter_stored`                                         |
| `external-agent.open`                  | `supervisor.rs` `open`                  | `an_unauthorized_workspace_is_refused_before_any_lookup_or_launch`, `concurrent_opens_of_one_id_share_one_launch`, `an_open_that_finishes_after_a_close_was_requested_is_closed_not_registered`                                       |
| `external-agent.turn`                  | `turns.rs` `turn`                       | `a_turn_streams_ordered_events_and_an_approval_round_trips`, `a_repeated_client_message_id_answers_without_a_second_turn`, `a_session_that_can_run_no_more_turns_is_closed_and_reported_lost_not_resendable`                          |
| `external-agent.respond`               | `turns.rs` `respond`                    | `a_response_is_refused_for_an_unknown_request_or_another_turn`, `a_single_choice_question_is_a_card_answered_as_a_question_never_as_a_permission`                                                                                     |
| `external-agent.steer`                 | `turns.rs` `steer`                      | `steering_is_answered_not_thrown_when_it_cannot_land`, `a_duplicate_steer_waiting_on_one_that_fails_in_transit_receives_its_failure`                                                                                                  |
| `external-agent.start-review`          | `turns.rs` `start_review`               | `a_review_on_a_target_without_native_review_is_refused_before_any_reservation`                                                                                                                                                        |
| `external-agent.cancel`                | `turns.rs` `cancel`                     | `cancelling_a_turn_ends_it_with_the_marker_before_completion_and_frees_the_session`, `a_cancel_for_a_turn_that_is_no_longer_running_never_stops_the_current_one`                                                                      |
| `external-agent.close`                 | `supervisor.rs` `close_session`         | `closing_a_live_session_is_idempotent_awaited_and_removes_its_scratch`, `closing_an_opening_session_cancels_it_and_waits_for_it_to_settle`                                                                                            |
| `external-agent.list-sessions`         | `supervisor.rs` `list_sessions`         | `listing_sessions_never_opens_a_conversation_and_authorizes_its_workspace`                                                                                                                                                            |
| `external-agent.refresh-account-usage` | `supervisor.rs` `refresh_account_usage` | `account_usage_without_a_live_session_is_nothing_to_report`, `account_usage_refuses_a_live_session_of_another_target`, `account_limits_carry_credits_spend_control_and_reset_credits_in_milliseconds`                                 |
| `external-agent.event` topic           | `turns.rs` relay                        | `concurrent_emitters_never_reorder_or_skip_a_sequence`, `a_refused_frame_spends_no_sequence`, `a_turn_past_the_persisted_budget_ends_with_its_own_error_and_is_stopped`, `a_long_streaming_command_stays_inside_the_persisted_budget` |

Rust tests live in `supervisor/tests.rs`, `turns.rs`, `launcher_tests.rs`, `isolation.rs`,
`hub_authority_tests.rs`, `map_tests.rs` and `map_events_tests.rs` under that directory.

### Compiled-runtime qualification

`apps/api/tests/integration/services/rust-runtime-external-agents-qualification.integration.test.ts`
drives the compiled binary with the hub's own session manager, approval registry and turn
controller. The vendor is `crates/mangostudio-runtime/examples/fake_cursor_agent.rs`, a
`cursor-agent` that pipes its stdio through the SDK's `FakeAcpAgent`, so the runtime discovers,
authorizes, launches and drives it exactly as it would the real CLI.

- **stdio:** an answered approval completes a turn, a user cancel while the vendor waits on its
  question ends the next one `cancelled-by-user`, a third turn runs on the same session, and close
  leaves no live session. Machine-side consent withdrawal ends a waiting turn and closes the
  session.
- **direct-URL serve** (same file) and **paired connect**
  (`apps/api/tests/integration/routes/rust-runtime-qualification-connect.integration.test.ts`):
  the transport's own `hub.workspace.authorize` binding admits the chat's workdir and an answered
  turn completes.

`cargo-shim.yml`'s real-binary job runs these on Linux, macOS and Windows. It builds the stand-in
in its own `cargo build --example` invocation, so the SDK's `testing` feature never reaches the
binary under qualification.

`rust-runtime-external-agents-live-smoke.integration.test.ts` is the separate, authenticated
evidence: opt-in through `MANGOSTUDIO_LIVE_AGENT_SMOKE=claude,codex,cursor`, it runs a one-word
turn against the signed-in CLIs on the machine, cancels a streaming Codex or Cursor turn and sends the next one at once, and never runs in CI.

A runtime-side consent withdrawal reaches the hub as the vendor ending the turn early
(`interrupted`), not as `consent-revoked`: the wire has no event that carries why the runtime
stopped a turn. The hub's own withdrawal path still ends turns `consent-revoked`.

The consent watcher reads `externalAgents` through the shared bounded, coalesced `ConsentReader`,
like the MCP, terminal and install watchers: only an explicit denial closes sessions, and a read
that does not finish within `CONSENT_READ_TIMEOUT` keeps them until the next poll. Launch-time
consent has two reads. The dispatcher's authorization guard makes the bounded read before
`external-agent.open` runs, and treats an inconclusive read as missing consent. The launcher then
re-reads consent synchronously immediately before the vendor child executes, failing closed, as
the terminal and command launch checks do. That second read is not time-bounded. If the store
hangs between the two reads, each vendor launch waiting on it holds one blocking permit until the
read returns. This is an accepted asymmetry with the watcher.

### Cancellation on Windows

Cancelling a turn is a protocol request for Codex (`turn/interrupt`) and Cursor (ACP
`session/cancel`), so neither depends on a process signal. The qualification above demonstrates the ACP cancel-and-continue path on Windows, and the live smoke cancelled a streaming Codex turn on Windows and completed the next one on the same session. If a
Codex cancel does not settle, the SDK tears the session down and it is reported lost (below). Claude has no protocol cancel: the SDK interrupts the
process, and the Windows launcher reports interrupt as unsupported
(`windows_interrupt_is_unsupported_and_kill_ends_the_job`), so a Claude cancel on Windows is a
forced termination of the process tree.

A forced Claude stop — on Windows always, elsewhere when the interrupt does not settle — leaves
that vendor session **nonresumable**: the SDK refuses every later turn on it. The runtime then
closes the session and answers the turn as a lost session, which the hub reports as
`session-lost` and follows by opening a new session on the next send. The conversation starts
over rather than resuming. A session the SDK sealed itself — Codex does after losing its
app-server or a cancel that never settled — takes the same path. Graceful interruption on Windows stays tracked separately and is not
required unless a bundled launcher comes to depend on it.

### Windows script entry points

Cursor's Windows installer puts its CLI in `%LOCALAPPDATA%\cursor-agent` as PowerShell scripts
(`agent.ps1`, `cursor-agent.ps1`); some installs also add `.cmd` shims that run those scripts. The
runtime supports that layout as follows:

- **Discovery.** On Windows the Cursor definition also searches `cursor-agent.ps1` after every
  `PATHEXT` name in each directory (so a `.cmd` or `.exe` beside it still wins), and searches
  `%LOCALAPPDATA%\cursor-agent` after `PATH`, read from the probing environment snapshot. A script
  found only there reports `installed-but-not-on-path` and still launches. `agent.ps1` is never
  searched: `agent` is a name other CLIs install too, and a probe runs the script it finds. No
  other vendor searches `.ps1`.
- **Launch.** A `.ps1` cannot be started by `CreateProcessW`. The Windows Job spawner
  (`crates/mangostudio-runtime/src/subprocess/powershell_script.rs`) rewrites it to
  `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile
  -NonInteractive -ExecutionPolicy RemoteSigned -File <script> <args...>`. The interpreter is
  named by full path, never searched for. The script path must be absolute, and a verbatim
  `\\?\` path (the canonical form the launch receives) is passed in its Win32 spelling, the same
  form the probe runs. `-File` passes every argument as a literal string, but Windows PowerShell
  5.1 re-quotes `$args` when the script starts its native program and on that hop mangles an
  embedded `"` and drops an empty string, so such arguments are refused rather than forwarded
  changed.
- **Execution policy.** The switch is not scoped to one process: PowerShell records it in
  `PSExecutionPolicyPreference`, which every descendant inherits, so any PowerShell the agent
  runs as a tool gets the same policy (checked on Windows 11: a nested `powershell.exe` reported
  `RemoteSigned`). That is why the launch uses `RemoteSigned` rather than the `Bypass` Cursor's
  own `.cmd` shim passes. `RemoteSigned` still runs the vendor script, which the `irm | iex`
  installer writes without a Mark-of-the-Web (checked against the real `cursor-agent.ps1`, which
  answered `--version`; `AllSigned` refused it, so the switch does take effect), while a
  downloaded, unsigned script run by a descendant stays blocked. `Bypass` would have turned that
  check off for the whole agent tree. The accepted cost: a stricter user policy (`AllSigned`,
  `Restricted`) is relaxed to `RemoteSigned` for the agent's tree. A machine or user Group Policy
  still overrides it. The External Agents SDK's own `.ps1` fallback passes no `-ExecutionPolicy`
  at all, and so fails under the default `Restricted` policy; the runtime diverges from it on
  purpose.
- **What is preserved.** The rewrite happens inside the same request the SDK's `ProcessLauncher`
  port handed the runtime's `GuardedProcessLauncher`, so the launch check, the kill-on-close Job
  that contains PowerShell and the vendor's `node.exe`, the SDK's environment allowlist (nothing
  is added for PowerShell), and the hidden window all apply unchanged. The version probe goes
  through the same spawner.
- **Batch shims.** A `.cmd` run by a probe inherits the runtime's environment; `cmd.exe` is then
  located from the runtime's own Windows directory (`GetSystemWindowsDirectoryW`) rather than
  refused for lacking an exact `SystemRoot`.

Support level: argv construction and discovery are unit-tested on every OS, and the batch probe
has a Windows test. The PowerShell launch is not exercised in CI, because Windows PowerShell with
a piped stdout is not a reliable test fixture. It was checked by hand against a real
`cursor-agent.ps1` on Windows 11 with the SDK's allowlisted environment and piped stdio, where
`--version` answered under both `Bypass` (about 2.3 s) and `RemoteSigned`.

### TypeScript assertion replacement map

TypeScript paths are pinned to `88800868f01c611c58234c6904b5f1288b3a942b`, the last
`feat/rust-runtime` commit before this map; the TypeScript runtime has since been deleted, so
they resolve only at that commit. Vendor adapter tests (`claude-*`, `codex-*`, `cursor-*`,
`vendor-contracts`, `turn-channel` and `external-agent-jsonrpc` under
`apps/runtime/tests/unit/services/`) moved with the vendor
protocols to the SDK and are not repeated here.

`external-agent-supervisor.test.ts`:

| TypeScript case                                                                                | Rust counterpart                                                                                                                                                                                                                                                                                                                                | Status                                                                |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| derives the manifest target list and omits an empty registry                                   | `the_registry_exposes_exactly_the_three_product_targets`; qualification health `targets`                                                                                                                                                                                                                                                        | covered                                                               |
| names the failing field when a method payload does not match its schema                        | method params are schema-checked by the dispatcher before a handler runs                                                                                                                                                                                                                                                                        | covered outside the host                                              |
| rejects optional capability drift during discovery                                             | —                                                                                                                                                                                                                                                                                                                                               | dropped: SDK capabilities are typed, not declared                     |
| accepts an implemented capability the machine cannot serve                                     | `cursor_missing_surface_does_not_blame_the_version`, `claude_refuses_a_mode_the_build_does_not_list`                                                                                                                                                                                                                                            | covered                                                               |
| authorizes a canonical workspace before resolving or opening an executable                     | `an_unauthorized_workspace_is_refused_before_any_lookup_or_launch`, `a_non_canonical_workspace_is_refused_without_asking_the_authority`                                                                                                                                                                                                         | covered                                                               |
| default-denies workspace launch when no authorization policy is supplied                       | `the_fallback_authority_denies_every_workspace`                                                                                                                                                                                                                                                                                                 | covered                                                               |
| refuses a turn workspace root the open call never authorized                                   | `a_turn_may_narrow_its_roots_but_never_widen_them`, `every_extra_workspace_root_is_authorized_at_open`                                                                                                                                                                                                                                          | covered                                                               |
| bounds discovery when the executable lookup never settles; keeps a healthy sibling target      | `a_stalled_probe_costs_only_its_own_target_and_is_told_to_stop`, `discovery_omits_a_failing_target_and_keeps_the_rest`                                                                                                                                                                                                                          | covered                                                               |
| aborts a pending workspace authorization through the open shutdown signal                      | `a_stalling_hub_refuses_once_the_bound_passes`, `an_open_stopped_before_it_launched_never_reaches_the_vendor`                                                                                                                                                                                                                                   | covered                                                               |
| hands every turn the executable that open resolved                                             | turns run on the SDK session opened with that executable                                                                                                                                                                                                                                                                                        | not applicable                                                        |
| resolves the toolchain open carried and reuses it; leaves `PATH` untouched without one         | `commands/toolchain.rs` tests; `open_resolves_its_toolchain_into_the_session_host_and_turns_reuse_it`                                                                                                                                                                                                                                           | covered                                                               |
| streams ordered semantic events and coalesces a retried client message id                      | `a_turn_streams_ordered_events_and_an_approval_round_trips`, `a_repeated_client_message_id_answers_without_a_second_turn`                                                                                                                                                                                                                       | covered                                                               |
| steer: forwards, passes a rejection through, answers not-supported, refuses a closed session   | `steering_is_answered_not_thrown_when_it_cannot_land`, `a_duplicate_steer_waiting_on_one_that_fails_in_transit_receives_its_failure`, `steering_a_session_that_is_not_open_is_refused_before_the_vendor`, `a_steer_naming_another_turn_is_refused_without_reaching_the_vendor`, `an_unstructured_steer_failure_is_returned_as_its_mapped_error` | covered                                                               |
| bounds concurrent sessions and recovers capacity after close                                   | `the_session_cap_counts_opening_sessions`, `closing_a_session_returns_its_capacity_to_the_next_open`                                                                                                                                                                                                                                            | covered                                                               |
| proactively cancels and closes an idle session when consent is revoked                         | `withdrawing_consent_closes_every_live_session_for_that_reason`; qualification consent test                                                                                                                                                                                                                                                     | covered                                                               |
| keeps live sessions through an inconclusive consent read; a hung read never delays shutdown    | `slow_consent_store_does_not_close_external_agent_sessions`, `a_hung_consent_read_does_not_hold_up_hub_shutdown`                                                                                                                                                                                                                                | covered                                                               |
| makes concurrent close calls share the same teardown barrier                                   | `closing_a_live_session_is_idempotent_awaited_and_removes_its_scratch`                                                                                                                                                                                                                                                                          | covered                                                               |
| aborts an opening session on close and reaps its late adapter result                           | `closing_an_opening_session_cancels_it_and_waits_for_it_to_settle`, `an_open_that_finishes_after_a_close_was_requested_is_closed_not_registered`                                                                                                                                                                                                | covered                                                               |
| surfaces a late-open reaper failure to explicit close and on shutdown                          | `a_failed_late_cleanup_is_reported_by_the_close_that_waited_for_it`                                                                                                                                                                                                                                                                             | covered                                                               |
| bounds explicit close while a late adapter open never settles; reaps an open past its deadline | `an_open_bounded_by_its_deadline_tells_the_vendor_to_stop`, `a_vendor_that_opens_while_being_stopped_is_closed_not_leaked`                                                                                                                                                                                                                      | covered                                                               |
| keeps watching consent for a pending reaper; refuses to register an opening during shutdown    | `the_consent_watcher_keeps_reading_while_a_cancelled_open_settles`, `the_hub_session_ending_shuts_every_session_down`                                                                                                                                                                                                                           | covered                                                               |
| does not emit an event delivered after consent revokes an active turn                          | `revoking_consent_mid_turn_closes_the_session_and_refuses_its_pending_answer`                                                                                                                                                                                                                                                                   | covered                                                               |
| silences a session whose events the hub refused; publishes until the refusal                   | `a_hub_that_stops_listening_is_diagnosed_once`, `a_refused_frame_spends_no_sequence`                                                                                                                                                                                                                                                            | covered                                                               |
| reports a silenced turn that its own deadline cancelled                                        | `a_turn_failure_nobody_hears_is_diagnosed_with_its_message`                                                                                                                                                                                                                                                                                     | covered                                                               |
| preserves adapter-owned environment keys through managed process launch                        | `the_child_sees_exactly_the_given_argv_cwd_and_env` (the SDK builds the allowlist)                                                                                                                                                                                                                                                              | covered                                                               |
| surfaces managed process cleanup failure from supervisor shutdown                              | `a_child_the_sdk_could_not_clean_up_is_reaped_before_the_failure_returns`                                                                                                                                                                                                                                                                       | covered                                                               |
| sanitizes and bounds vendor display strings before emitting them                               | `an_error_message_past_the_cap_is_cut_and_marked`, `an_overlong_option_label_is_cut_and_marks_the_card`, `output_renders_as_its_text_and_is_cut_at_the_detail_cap`                                                                                                                                                                              | covered                                                               |
| stops a turn before an oversized aggregate payload leaves the runtime                          | `a_turn_past_the_persisted_budget_ends_with_its_own_error_and_is_stopped`                                                                                                                                                                                                                                                                       | covered                                                               |
| refuses an unbounded native turn id and aborts its adapter context                             | `an_unbounded_native_turn_id_is_refused_and_its_vendor_turn_stopped`, `an_unbounded_review_turn_id_is_refused_and_its_vendor_review_stopped`                                                                                                                                                                                                    | covered                                                               |
| turns a mid-stream adapter crash into a bounded error and cancellation                         | `error_carries_code_message_vendor_code_request_id_and_retryable`, `a_mid_stream_adapter_crash_ends_the_turn_with_its_error_and_frees_the_session`                                                                                                                                                                                              | covered: the SDK commits the crash as the terminal and owns the child |
| refuses unknown additive and host-tool event shapes at the runtime boundary                    | every mapped event validates against the topic schema (`map_events_tests.rs`)                                                                                                                                                                                                                                                                   | covered                                                               |
| enforces the hard turn deadline even while a stream remains active                             | `a_turn_past_its_hard_deadline_ends_with_its_own_error_and_frees_the_session`, `the_hard_deadline_fires_while_the_stream_never_pauses`                                                                                                                                                                                                          | covered                                                               |
| idle deadline; not idle while awaiting an approval; stops waiting once the approval expired    | SDK `Limits::idle_timeout` and `approval_timeout`: ACP turns observe it since 0.3.0, and Codex command output, MCP progress and patch updates restart it; the runtime reports its expiry as an error (`an_idle_timeout_ends_the_turn_with_its_own_error_not_a_bare_cancel`)                                                                     | moved to the SDK                                                      |
| refuses a listing for an unauthorized workspace; passes the canonical workspace through        | `listing_sessions_never_opens_a_conversation_and_authorizes_its_workspace`                                                                                                                                                                                                                                                                      | covered                                                               |
| refuses a target whose adapter has no listing; bounds listed text                              | `listing_a_target_without_session_listing_is_refused_by_name`, `native_sessions_convert_times_and_cap_at_fifty`                                                                                                                                                                                                                                 | covered                                                               |
| refuses a session that advertises nativeReview without implementing it                         | SDK core conformance (0.3.0) fails a harness that declares native review but refuses it                                                                                                                                                                                                                                                         | moved to the SDK                                                      |
| refuses a review on a session whose open reported no nativeReview                              | `a_review_on_a_target_without_native_review_is_refused_before_any_reservation`                                                                                                                                                                                                                                                                  | covered                                                               |
| review streams through the turn's session, sequence, topic, receipt and slot rules             | `a_review_follows_the_session_sequence_topic_receipt_and_slot_rules`, `a_review_on_another_thread_is_refused_and_stopped_before_the_hub_sees_it`                                                                                                                                                                                                | covered                                                               |

`external-agent-isolation.test.ts` is ported case for case in `isolation.rs`, including
`fingerprint_matches_the_typescript_derivation_byte_for_byte`, and the qualification proves the
compiled binary's fingerprint equals Local's on the same home. `external-agent-process.test.ts`
maps to `launcher_tests.rs` (exact argv, cwd and env; bounded, redacted stderr; tree kill;
interrupt), except its Windows `taskkill` escalation cases, which the kill-on-close Job replaces.
`external-agent-runtime.test.ts` (a fake adapter through the real framed host) is superseded by the
compiled-runtime qualification above.
