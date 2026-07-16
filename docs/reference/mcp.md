# MCP Servers

MangoStudio can connect to [Model Context Protocol](https://modelcontextprotocol.io) servers
and expose their tools to the agent. Servers are managed per user; their tools are composed
onto the built-in tools for each turn and never enter the global tool registry.

## Transports

Two transports are supported (`apps/api/src/services/mcp/client-factory.ts`):

- **stdio** — MangoStudio spawns a local process (`command` + `args`) and speaks MCP over its
  stdin/stdout. The server runs as a local child process with the API's privileges.
- **http** — MangoStudio connects to a Streamable HTTP endpoint (`url`). A modern Streamable
  HTTP client is tried first; on a 4xx from the initialize POST it falls back to the legacy
  SSE transport, per the MCP spec-compat recipe.

Only `apps/api/src/services/mcp/**` may import `@modelcontextprotocol/sdk`; the rest of the
codebase consumes the project-owned `McpClientHandle` wrapper, so an SDK bump stays contained
to that directory.

## Configuration

Servers are stored in the database and managed through the API
(`apps/api/src/modules/mcp-servers/http/mcp-server-routes.ts`) and the MCP settings page
(`apps/frontend/src/features/settings/mcp/`). Fields
(`apps/shared/src/mcp/schemas.ts`):

| Field       | Applies to | Notes                                                                                      |
| ----------- | ---------- | ------------------------------------------------------------------------------------------ |
| `name`      | both       | Display name (≤ 100 chars).                                                                |
| `slug`      | both       | Per-user unique id, `^[a-z0-9]+(?:-[a-z0-9]+)*$` (≤ 64 chars). Becomes the tool namespace. |
| `transport` | both       | `stdio` or `http`.                                                                         |
| `command`   | stdio      | Executable to spawn.                                                                       |
| `args`      | stdio      | Argument vector.                                                                           |
| `env`       | stdio      | **Non-secret** child environment variables.                                                |
| `secretEnv` | stdio      | Secret child environment values — write-only, stored in the secret store.                  |
| `url`       | http       | Streamable HTTP endpoint.                                                                  |
| `headers`   | http       | Auth headers — write-only, stored in the secret store.                                     |
| `enabled`   | both       | Disabled servers contribute no tools.                                                      |
| `timeoutMs` | both       | Per-request cap; `null` uses the built-in default.                                         |

### Portable export and conflict-aware import

Settings → MCP can export all or selected servers as a stable portable v1 document. Its
`mcpServers` map stays ecosystem-compatible; the optional `x-mangostudio` namespace carries
safe metadata and unresolved secret names. Database/user ids, timestamps, runtime status,
errors, and secret values are never serialized. Entries and object keys are sorted so two
equivalent exports produce reviewable diffs.

Import accepts a browser file, pasted JSON, or an absolute (or `~`-prefixed) `.json` path on
the API host (capped at 1 MiB). Preview normalizes configurations and compares exact
fingerprints, slug/name, canonical URL, and stdio command+arguments. Exact matches default to
**skip**; non-identical collisions require an explicit **skip**, **replace**, or **copy**
decision, with a deterministic copy name/slug shown before apply. Unsupported transports,
`${VAR}`-style placeholders, malformed entries, and duplicate source slugs are reported,
never guessed.

Credential-shaped literals are redacted in preview and converted to write-only secret
storage. Exported secret names are unresolved references; the destination must supply their
values before applying an add, replacement, or copy. A preview token binds the source bytes
and current managed configuration, so an edited file or concurrent server change requires a
fresh review.

Legacy public env credentials are exported as unresolved secret names, and URL userinfo is
converted to an unresolved `Authorization` header. Credential-shaped URL query parameters
cannot be represented safely and must be moved to write-only headers before export/import.

The portability endpoints are `POST /mcp/servers/portability/export`,
`POST /mcp/servers/portability/import/preview`, and
`POST /mcp/servers/portability/import/apply`. Apply prevalidates every decision, assigns new
ids, stages secret bundles under those ids, then deletes/replaces/inserts all selected rows in
one Kysely transaction. A database failure rolls back every row and removes all staged
secrets. After commit, replaced sessions and old secret bundles are disposed. The external
OS secret store is not part of the SQLite transaction; its atomicity is implemented through
staging and compensation.

The original create-only `POST /mcp/servers/import/preview` and
`POST /mcp/servers/import` endpoints remain available for compatible integrations. They keep
their idempotent duplicate-slug behavior while routing credential-shaped environment values
into write-only storage.

## Secret handling

Auth is kept out of plaintext config. For http servers, header **values** are accepted on
write only and persisted to the secret store; responses and the server row expose only the
header **names** (`headerNames`). Stdio servers use `env` for non-secret variables and
`secretEnv` for write-only values; responses expose only `secretEnvNames`. At spawn time the
two maps are merged, with secret values winning on a duplicate key.

The spawned child does **not** inherit the API process environment wholesale. Only a small
allowlist (`PATH`, `HOME`, `TERM`, … — see `apps/api/src/services/mcp/stdio-env.ts`) plus the
managed public and secret environment maps is forwarded, so connector API keys and the app's
auth secret never leak accidentally. Exported shell functions are stripped to avoid a
Shellshock-style injection vector.

## Tool namespacing and per-agent allowlists

Each server tool is exposed as `mcp__<slug>__<tool>`
(`apps/api/src/services/mcp/tool-naming.ts`). The slug charset forbids underscores, so the
first `__` after the `mcp__` prefix unambiguously terminates the slug. Tool descriptions are
prefixed with `[<server name>]` so the model can tell servers apart. Names longer than 64
characters are dropped at definition time rather than failing the provider request.

An agent's tool allowlist (`toolNames`) admits MCP tools three ways:

- `*` — every tool, built-in and MCP;
- `mcp__<slug>__*` — every tool of one server;
- `mcp__<slug>__<tool>` — one exact tool.

A tool must also be enabled in the user's tool settings; a disabled MCP tool never reaches the
provider. The set of resolved MCP tools is folded into the agent runtime hash, so enabling,
disabling, or reconfiguring a server invalidates any cached continuation for the next turn.

## Timeouts and connection lifecycle

Connections are lazy and per `(user, server)`: the first use connects, concurrent callers
share the in-flight connect, and idle sessions are kept alive until the server row changes or
the app shuts down (`apps/api/src/services/mcp/connection-manager.ts`). There is no background
retry loop — a dropped or crashed session (status falls to `disconnected`) simply reconnects on
next use. During turn resolution, each server gets a 3s budget to connect and list its tools; a
server that misses the budget is skipped and logged, and never fails the turn or hides other
servers' tools. Tool execution honors the server's `timeoutMs` (default 60s), enforced by the
SDK so a timed-out request is actually cancelled.

Failures degrade instead of aborting the turn: a server tool error, an unreachable server, or a
timeout is recorded as a typed error tool result and the turn continues. Oversized results are
capped at 64 KiB with a truncation marker (`apps/api/src/services/mcp/content-mapping.ts`).

## Form elicitation

MangoStudio declares the MCP client `elicitation.form` capability
(`apps/api/src/services/mcp/client-factory.ts`). When a server sends `elicitation/create` during
an in-flight tool call, the API parks the request
(`apps/api/src/services/mcp/elicitation-registry.ts`), streams an `mcp_elicitation_request` SSE
chunk into the open chat turn, and renders a form card. The user accepts (with field values),
declines, or cancels via `POST /mcp/elicitations/:id/respond`; that unblocks the awaited MCP
tool call so it can finish normally.

URL-mode elicitation is not declared; unexpected URL requests resolve as `{ action: "cancel" }`
so servers degrade. If the tool call times out or the turn aborts while a form is pending, the
registry answers `{ action: "cancel" }` as well. Without an active turn sink (for example a
server probing elicitation outside a chat tool call), the handler also cancels.

## Rich tool results

The model always receives the flattened text result: text blocks and text-bearing embedded
resources are inlined (capped at 64 KiB), and rich blocks contribute a bracketed placeholder.
In parallel, image content blocks and allowlisted binary embedded resources of a successful
call are persisted (`apps/api/src/services/mcp/rich-content.ts`) and rendered inline in chat as
`mcp_media` message parts carrying provenance (server slug, tool name, tool call id):

- **Images** (`image/png|jpeg|webp|gif|avif`) go through generated-image storage and render
  like `generate_image` output. They are not registered as gallery artifacts.
- **Binary embedded resources** (`application/pdf`) become chat attachments with a download
  chip.

Persistence is best-effort per block with a 10 MiB decoded-size cap: an oversized, disallowed,
or failing block is logged and skipped, leaving only the text placeholder — never failing the
tool call.

## Resources and prompts

Servers advertising the `resources` or `prompts` capability get two extra surfaces
(`apps/api/src/modules/mcp-servers/application/mcp-resource-prompt-service.ts`):

- **Settings → MCP** — each server card has a resources browser that lists resources and
  previews text contents inline.
- **Chat composer** — the MCP menu lists every enabled server's prompts and resources. A prompt
  inserts its resolved text into the input (argument-bearing prompts get a small form first).
  A resource is attached to the current chat as context: `POST
  /mcp/servers/:id/resources/read` with a `chatId` persists text (`text/plain`, `markdown`,
  `csv`, `json`), image, and PDF contents as chat attachments, and the next turn carries their
  ids through the existing attachments pipeline.

Endpoints are capability-gated: a server that did not advertise the primitive answers 404 with
code `UNSUPPORTED`, and the UI hides the affordance. Prompt resolution
(`POST /mcp/servers/:id/prompts/resolve`) flattens each prompt message to plain text — inserted
prompts are ordinary composer text with no new message semantics.

## Trust model

An **stdio** server is a local process spawned with the API's privileges and file access — treat
it exactly like software you install and run yourself, and only configure commands you trust. An
**http** server runs remotely; its tools can still act on whatever the endpoint exposes, so
review a server before enabling it and scope agents with per-server allowlists.

## Troubleshooting

- **A server's tools don't appear.** Confirm the server is enabled and that the agent's
  allowlist admits its tools (`*`, `mcp__<slug>__*`, or the exact name). Use the **Test** action
  on the settings page to probe the connection and list tools without running a turn.
- **`status: error` after Test.** The `statusError` detail carries the connection or handshake
  failure (bad command, unreachable URL, rejected headers).
- **stdio server can't find a binary or config.** The child env is allowlisted; pass public
  values through `env` and credentials through write-only `secretEnv`.
- **A tool call returns a timeout error.** Raise the server's `timeoutMs`, or check whether the
  server hangs; the turn still completes with the error result recorded.
- **A long tool result looks cut off.** Results over 64 KiB are truncated with a marker by
  design, to protect the context window.
