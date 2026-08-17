# Cursor

**Cursor is external-only.** The MangoStudio-owned Cursor provider is deprecated and no longer
runs turns. Cursor is reached through the external-agent adapter, where Cursor's own CLI owns the
model, the tools and the approvals.

## Why the provider went away

Cursor was reachable two ways with **inverted ownership**:

| Path                     | Who picks the model | Who declares the tools | Who executes them | Who approves |
| ------------------------ | ------------------- | ---------------------- | ----------------- | ------------ |
| Provider (removed)       | MangoStudio         | MangoStudio            | MangoStudio       | MangoStudio  |
| External agent (current) | Cursor              | Cursor                 | Cursor            | Cursor       |

One vendor appearing twice in one selector with opposite semantics is exactly the ambiguity that
produces a bug where MangoStudio executes or authorizes a tool the vendor was supposed to own.

This was not an outage and not a Cursor failure. The external path is better on every axis that
matters: it uses the user's own Cursor login instead of an API key MangoStudio stores, it inherits
their rules and MCP configuration, it needs no Node.js on the host, and it ships none of Cursor's
bytes in the MangoStudio binary.

**This says nothing about the ChatGPT connector.** The two look parallel and are not: the ChatGPT
connector serves ChatGPT *models* through MangoStudio's own agent loop, which is an internal
provider with no external twin. Codex CLI is the external agent. Different products, different
ownership, no duplication.

## Using Cursor today

Open the runner selector in the composer and pick **Cursor**. See
[external agents](../architecture/external-agents.md) for how vendor CLIs are discovered, what a
workspace-trust grant covers, and how approvals are routed.

Cursor CLI must be installed on the machine the chat runs on. The Environments page detects it and
can install it; nothing is vendored into MangoStudio.

## What a chat with a stored `cursor/*` model does

Nothing silently changes. A chat whose `model` or `textModel` is a `cursor/*` id keeps that value,
and the next turn is refused with a typed error rather than rewritten:

- HTTP `503`, code `MODEL_PROVIDER_DEPRECATED`
- `details.reason` is `provider-deprecated`, with `modelId`, `provider` and `targetId`
- The composer renders it above the input with one action: **continue in a new chat with Cursor
  CLI**

That action **forks** — it never converts the chat in place. A chat has one runner kind for life,
because a transcript that mixed owners would replay Cursor's assistant text back to MangoStudio's
own model as its own prior output. The fork carries the environment and the workdir and starts with
no transcript; the original chat is untouched. Picking a different model in the composer keeps you
in the chat you are already in.

The refusal is raised in `resolveModel`
(`apps/api/src/modules/generation/application/resolve-model.ts`), before provider resolution, so
every path reaches it: the streaming turn, the non-streaming respond route, capability inspection,
title generation, commit messages, context compaction, subagents and library agent strategies.
Hiding the catalog entries alone would not have been enough — an explicit stored id is accepted even
when catalog metadata is absent.

## Your connector and your API key

Both survive. The connector is visible, editable and deletable in **Settings → Connectors**, marked
`Legacy` with a line pointing at the CLI runner. Its stored secret is **not** deleted.

What is closed off is new setup, on the server and not just in the picker: `POST /connectors` with
`provider: "cursor"` answers `410` with code `UNSUPPORTED`. Hiding the form alone would have been
bypassable, since the endpoint accepts a provider whether or not a form rendered it.

`mango doctor` reports a `Cursor connector` warning when a key is still configured, so an operator
can see what is left to clean up.

## Deprecation telemetry

The execution guard increments a per-provider counter that rides the existing local observability
snapshot — nothing leaves the machine, and no reporting channel was added. `GET /api/observability/metrics`
reports it as `deprecatedAttempts` on the `cursor` provider entry:

```json
{ "refusedTurns": 3, "lastAttemptedAt": 1770000000000, "lastModelId": "cursor/composer-2.5" }
```

Absent until the first refusal. This is what makes "the deprecation window has elapsed for
everyone" checkable instead of asserted — and, with the doctor warning above, it answers both
questions the removal of the connector and its secret depends on: is anything still attempting a
`cursor/*` turn, and is a Cursor connector still configured.

## What was removed

The provider's implementation is gone, along with the Node sidecar it ran on:

| Removed                                              | What it was                                  |
| ---------------------------------------------------- | -------------------------------------------- |
| `apps/api/src/services/providers/cursor/sidecar/`    | the Node sidecar entrypoint and runtime      |
| `apps/api/src/services/providers/core/node-sidecar/` | spawn plumbing; Cursor was its only consumer |
| `apps/shared/src/catalog/cursor-native-packages.ts`  | native-package catalog                       |
| `scripts/lib/cursor-sidecar.ts`                      | build-time SDK tree staging                  |
| `@cursor/sdk`                                        | dependency and lockfile entries              |

With them went the vendored SDK tree in every release archive and npm platform package, the
`[cursor]` section of `config.toml` (`workspace_dir`, `sidecar_script`, `node_path`), the
`CURSOR_WORKSPACE_DIR` / `MANGO_CURSOR_SIDECAR_SCRIPT` / `MANGO_NODE_PATH` environment variables,
and `doctor --cursor-probe`.

`apps/api/src/services/providers/cursor/index.ts` remains as a registration with no implementation.
It exists so a stored `cursor/*` id resolves to a provider that can be named rather than to an
unknown-provider crash.

**Generic Node.js support is unaffected.** Node and NVM are first-class environment targets,
detected and installable for reasons that have nothing to do with any provider. Detection reports
no generic Node floor of its own — nothing in-tree needs one — and a caller with a genuine minimum
(a specific consumer, not this deprecated provider) supplies it per probe instead.
