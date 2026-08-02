# Agent Playbooks

Open only the section that matches the current task. This file is intentionally more detailed than `AGENTS.md` and should be used on demand, not by default.

This page is a navigation aid for contributors and coding agents. Start from the
closest entry point to the task, then fan out one layer at a time.

## Auth

Open these first:

- `apps/api/src/auth.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/plugins/auth-middleware.ts`
- `apps/api/src/plugins/api-key-guard.ts`
- `apps/api/src/plugins/rate-limit-policy.ts`
- `apps/api/src/modules/api-keys/application/api-key-service.ts`
- `apps/api/src/modules/api-keys/http/api-key-routes.ts`
- `apps/shared/src/api-keys/schemas.ts`
- `apps/frontend/src/features/settings/external-api/` (Settings → External API UI)
- `apps/frontend/src/routes/_authenticated/settings/external-api.tsx`
- `apps/frontend/src/lib/auth-client.ts`
- `apps/frontend/src/routes/login.tsx`
- `apps/frontend/src/routes/signup.tsx`
- `apps/frontend/src/routes/_authenticated.tsx` (client-side route guard)
- `docs/reference/external-api.md` (automation-facing HTTP API keys)
- `tests/browser-smoke/auth-flow.spec.ts`

## API Routes And Contracts

Open these first:

- `apps/api/src/app.ts`
- the target file under `apps/api/src/modules/*/http/`
- `apps/shared/src/contracts/index.ts`
- the matching frontend hook, service, or route
- the relevant API and frontend tests

## Realtime Invalidation

Read [`../architecture/realtime.md`](../architecture/realtime.md) first. Then
open:

- `apps/shared/src/realtime/`
- `apps/api/src/modules/realtime/http/realtime-routes.ts`
- `apps/api/src/services/realtime/realtime-bus.ts`
- `apps/frontend/src/lib/realtime/realtime-client.ts` (one socket per tab)
- `apps/frontend/src/lib/realtime/use-realtime-invalidation.ts` (consumer entry point)
- the producer's application mutation path
- `apps/api/src/modules/chats/domain/chat-ownership.ts` for chat-scoped topics
- `apps/api/tests/integration/routes/realtime-routes.integration.test.ts`

Keep the channel invalidation-only. New resource topics need a shared TypeBox
grammar, route-side ownership authorization, same-user and cross-user
real-server coverage, and a frontend mapping that refetches data over HTTP.

## Chat, Streaming, And Generation

First read `docs/architecture/continuation.md` and `docs/providers/development.md` for
context on the continuation architecture and provider integration patterns.

Open these first:

- `apps/api/src/modules/generation/http/respond-stream-routes.ts`
- `apps/api/src/modules/generation/application/stream-text-turn.ts`
- `apps/api/src/modules/generation/application/resolve-model.ts`
- `apps/api/src/modules/chats/` (ownership, chat repository)
- `apps/api/src/modules/messages/` (message repository, persistence)
- `apps/api/src/services/providers/core/continuation-envelope.ts`
- `apps/api/src/services/providers/core/continuation-runtime.ts`
- `apps/api/src/services/providers/core/context-policy.ts`
- `apps/api/src/services/providers/core/replay-builder.ts`
- `apps/api/src/services/providers/gemini/interactions-stream.ts`
- `apps/api/src/services/providers/openai/responses-stream.ts`
- `apps/api/src/services/providers/openai-compatible/chat-completions-stream.ts`
- `apps/api/src/services/providers/anthropic/stream.ts`
- `apps/api/src/services/providers/deepseek/agent-stream.ts`
- `apps/api/src/services/providers/deepseek/client.ts`
- `apps/api/src/services/providers/chatgpt/`
- `apps/api/src/modules/generation/http/respond-routes.ts` (non-streaming fallback)
- `apps/api/src/modules/chats/http/chat-routes.ts`
- `apps/api/src/modules/messages/http/message-routes.ts`
- `apps/shared/src/streaming/events.ts`
- `apps/shared/src/streaming/schemas.ts`
- `apps/frontend/src/features/chat/ChatPage.tsx`
- `apps/frontend/src/features/generation/hooks/use-text-generation.ts`
- `apps/frontend/src/features/chat/hooks/use-chat-stream.ts`
- `apps/frontend/src/services/generation-service.ts`
- `apps/shared/src/contracts/index.ts`

## Connectors, Providers, And Secret Storage

Open these first:

- `apps/api/src/modules/connectors/http/connectors-routes.ts`
- `apps/api/src/modules/connectors/http/chatgpt-oauth-routes.ts`
- `apps/api/src/modules/connectors/http/gemini-aliases-routes.ts`
- `apps/api/src/modules/connectors/application/`
- `apps/api/src/modules/connectors/infrastructure/chatgpt/`
- `apps/api/src/services/providers/`
- `apps/api/src/services/secret-store/`
- `apps/api/src/modules/provider-settings/http/provider-settings-routes.ts`
- `apps/api/src/lib/config.ts`
- `apps/frontend/src/features/settings/connectors/`
- `apps/frontend/src/features/settings/providers/`
- `apps/frontend/src/hooks/use-model-catalog.ts`

## Tool Calling And Agentic Flows

Open these first:

- `apps/api/src/services/tools/registry.ts` (registration + lookup)
- `apps/api/src/services/tools/`
- `apps/api/src/services/tools/builtin/create-file.ts`
- `apps/api/src/services/tools/builtin/edit-file.ts`
- `apps/api/src/services/tools/builtin/replace-range.ts`
- `apps/api/src/services/tools/builtin/apply-patch.ts`
- `apps/api/src/services/tools/builtin/_v4a-patch.ts`
- `apps/api/src/services/tools/builtin/delete-file.ts`
- `apps/api/src/services/tools/builtin/move-file.ts`
- `apps/api/src/services/tools/builtin/generate-image.ts`
- `apps/api/src/services/tools/builtin/get-current-datetime.ts`
- `apps/api/src/services/tools/builtin/ask-user-question.ts` (interactive question cards)
- `apps/api/src/services/tools/builtin/todo.ts` (per-chat task list; prompt-injected via `apps/api/src/modules/todos/`)
- `apps/api/src/modules/todos/http/todo-routes.ts` (`GET /api/chats/:id/todos` current-state endpoint)
- `apps/shared/src/questions/` (question schemas + answer formatting)
- `apps/shared/src/todos/` (todo schemas, helpers, prompt-section renderer)
- `apps/frontend/src/features/chat/components/ToolCallVisuals.tsx` (per-tool call rendering)
- `apps/frontend/src/features/chat/components/QuestionCard.tsx`
- `apps/frontend/src/features/chat/components/TodoListPart.tsx` (inline feed snapshot; shares `TodoItemRow.tsx`)
- `apps/frontend/src/features/chat/components/PinnedTodoPanel.tsx` (live panel above the input bar)
- `apps/frontend/src/features/chat/hooks/use-chat-todos.ts` (todo query + `todo_update` cache writer)
- `apps/api/src/modules/tool-settings/http/tool-settings-routes.ts`
- `apps/api/src/modules/generation/application/stream-text-turn.ts`
- `apps/api/src/services/providers/core/continuation-envelope.ts`
- `apps/api/src/services/providers/core/tool-mapper.ts`
- `apps/shared/src/types/index.ts`
- `apps/frontend/src/features/generation/hooks/use-text-generation.ts`
- `apps/frontend/src/features/settings/tools/`

Per-message **file checkpoints** cover the built-in filesystem mutation tools above, including the ones a subagent (`delegate_to_agent`) or the Cursor sidecar runs — those inherit the delegating turn's `assistantMessageId`, so their mutations join the same manifest. Revert is whole-turn (`POST /api/chats/:id/checkpoints/:messageId/revert`) and compares on-disk hashes before restoring. **Not checkpointed:** shell tools and MCP file writes — only explicit builtin mutators participate.

## Skills

Open these first:

- `apps/api/src/modules/skills/application/skill-discovery.ts` (source scan, precedence, memo)
- `apps/api/src/modules/skills/application/skill-content.ts` (body + sandboxed file reads)
- `apps/api/src/modules/skills/application/skills-prompt-section.ts` (`<available-skills>`)
- `apps/api/src/modules/skills/application/skill-settings-service.ts`
- `apps/api/src/modules/skills/http/skill-routes.ts`
- `apps/api/src/services/tools/builtin/skill.ts` (lazy-load tool)
- `apps/shared/src/skills/`
- `apps/frontend/src/features/settings/skills/`
- Reference: `docs/reference/skills.md`

## Library (Coverage, Divergence, Propagation)

Open these first:

- `apps/api/src/modules/library/domain/registry.ts` (locations, targets, per-kind read precedence)
- `apps/api/src/modules/library/application/library-discovery.ts` (scan, cache, grouping)
- `apps/api/src/modules/library/application/coverage-resolver.ts` (present / absent / shadowed)
- `apps/api/src/modules/library/application/propagation-preview.ts` (source groups, outcomes)
- `apps/api/src/modules/library/application/propagation-apply.ts` (token, backup, verify, undo)
- `apps/api/src/modules/library/application/adapters/` (format conversion strategies)
- `apps/api/src/modules/library/http/library-routes.ts`, `propagation-routes.ts`, `settings-routes.ts`
- `apps/shared/src/library/schemas.ts` (single source of truth for every shape)
- `apps/frontend/src/features/library/` (`format.ts` holds the cell-state rules,
  `propagation.ts` mirrors the apply contract's validation)
- `apps/frontend/src/routes/_authenticated/environments/library/` (the pages;
  `environments/library.tsx` is the section layout and its tab strip)
- `apps/frontend/src/routes/_authenticated/library/` (redirect stubs only —
  every file forwards a pre-move `/library/*` bookmark and renders nothing)

The library is a section of the environments umbrella, not a top-level surface:
its URLs live under `/environments/library`, and the sidebar reaches it through
the Environments entry.

There is no canonical copy of a resource: when versions diverge, only a human
picks the winner. The API refuses an apply that does not name one, and the UI is
built so a user cannot reach that error.

Every location carries a `scope`, and every one of them is `home` today. The
`workspace` scope is reserved: nothing resolves under a repository root yet, and
`apps/api/tests/unit/modules/library/scope-seam.test.ts` fails if a workspace
location is added without the settings toggles and cross-scope read precedence
that have to come with it. Precedence between a workspace copy and a home copy
is a per-target fact and belongs in `TargetDefinition.reads`, never in a
resolver.

## Environments (Toolchains, Version Managers, Agent CLIs, Library)

Open these first:

- `apps/shared/src/environments/detection/` (the pure domain: PATH scan, duplicate
  analysis, runtime and agent definitions, auth signals, nvm, the Node release policy)
- `apps/runtime/src/services/probing/` (the same domain bound to a real host —
  `service.ts` is the three `probing.*` methods, `host-env.ts` the fs/spawn seams)
- `apps/api/src/modules/environments/application/probing-service.ts` (per-environment
  cache, force/dedupe, and the policy the hub sends down)
- `apps/api/src/modules/environments/application/install-service.ts` (guards, prepare, run)
- `apps/runtime/src/services/install.ts` (the spawn+capture loop, and only that)
- `apps/api/src/modules/environments/http/environment-routes.ts`, `install-routes.ts`
- `apps/shared/src/environments/schemas.ts` (single source of truth for every shape)
- `apps/frontend/src/features/environments/` (`format.ts` holds the presentation rules;
  `use-environment-scope.ts` is which machine a tab is describing)
- `apps/frontend/src/routes/_authenticated/environments/`

Detection runs on the runtime and describes *that* machine. Toolchains, Agents and
Health carry an `environmentId` search param (absent means the hub's own), and the
Health tab's compare mode puts two of them side by side.

The umbrella covers everything about the user's tooling, so its tabs are
Overview, Toolchains, Agents, Health, and Library — the last one nests the whole
library surface above. "Toolchains" is an i18n label: the route is still
`/environments/runtimes` and `RuntimeIdSchema` is unchanged.

### Overview (the landing page)

- `apps/frontend/src/routes/_authenticated/environments/index.tsx` (prefetches,
  never `ensure`s — sections render their own pending state)
- `apps/frontend/src/features/environments/components/OverviewPage.tsx`
  (composition plus the agents grid and toolchains strip)
- `OverviewSection.tsx` (heading, link to the summarized tab, per-section
  loading and error states)
- `OverviewAgentCard.tsx`, `OverviewToolchainCard.tsx`,
  `OverviewHealthRollup.tsx`, `OverviewLibrarySnapshot.tsx`

The overview **adds no endpoint**: every section reads the queries its tab
already owns, so any number on it can be verified by opening that tab. A number
that is not already served is dropped, never fetched from something new here.

Sections are independent by design — one failing query costs its own block and
nothing else — and they are siblings, so a new one is an addition rather than a
rewrite. Rollups read the reported `health`, not the finding list, which is what
keeps a tool installed off PATH counted as needing attention here exactly as its
own card says.

### Cards

`components/ToolCard.tsx` is the anatomy every tool card shares: identity header
(avatar, effective name, the rename/reset menu), body, actions footer. Cards
differ in body, never in shell, and the id hook each one is found by
(`data-runtime-id`, `data-target-id`) is passed through it rather than derived —
tests key on those attributes. Presentation rules stay in `format.ts` where they
can be asserted without a rendered tree: which binary is effective, which recipe
performs an action, which finding a summary leads with, and the health rollup.

### Tool identity (names and avatars)

- `apps/shared/src/tool-identity/` (subject-key grammar and the stored shape)
- `apps/api/src/modules/tool-identity/` (list, upsert, reset, image upload and
  serve; publishes the `tool-identity` settings invalidation scope)
- `apps/frontend/src/features/environments/identity/` (`resolve.ts` is the
  fallback chain; `use-tool-identities.ts` is what every surface calls)
- `apps/frontend/src/components/ui/ToolAvatar.tsx` and
  `tool-avatar-palette.ts` (literal colour pairs per theme, asserted for
  contrast)

A subject key is `<kind>:<id>` over ids that already exist elsewhere
(`agent:claude`, `runtime:bun`, `version-manager:nvm`, `mcp:<slug>`). The
registry is **display-only**: an override changes what a human reads and
nothing else, so no wire id, provider-facing tool name, or API path may be
derived from it. Consumers live in environments cards, `library/CoverageMatrix`,
`settings/mcp`, and the chat capability inspector.

#### Avatar images

- `application/tool-image-validation.ts` decides the type from the bytes for
  both an upload and a cached remote image. PNG, JPEG, and WebP only; **SVG is
  refused by name and must stay refused** — it is markup that can carry script,
  and these bytes are served back from our own origin.
- `infrastructure/tool-image-storage.ts` owns the files, under
  `toolImages.dir` (`~/.mango/tool-images/<userId>/`, parsed only in
  `lib/config.ts`). A file is keyed by its identity row and deleted with it, so
  there is no orphan sweep.
- Serving pins the type recorded at write time and sends `nosniff`. Never infer
  the type from the file at serve time.
- Caching a URL fetches it through `lib/safe-fetch.ts`; that path, not the
  storage layer, is where the SSRF guard lives.
- The frontend never renders a stored image without a fallback:
  `ToolAvatar` drops back to the monogram on a load error, and an uncached
  address is loaded with no referrer and no cookies.

There is no CSP on the app today, so a hotlinked `https:` image loads without
one. If a policy is ever added, `img-src` has to permit `https:` or every
uncached avatar silently becomes a monogram.

## MCP Servers

Open these first:

- `apps/runtime/src/services/mcp/` (SDK boundary, transports, session registry —
  the server runs on the environment's runtime, not in the hub)
- `apps/api/src/services/mcp/runtime-session.ts` (hub handle over the protocol,
  secret delivery, elicitation hop)
- `apps/api/src/services/mcp/connection-manager.ts` (per-user sessions, reconnect)
- `apps/api/src/services/mcp/tool-bridge.ts` (namespacing + per-turn resolution,
  scoped to the chat's environment)
- `apps/api/src/services/mcp/tool-naming.ts`, `header-secrets.ts`,
  `secret-transport-guard.ts`
- `apps/api/src/modules/mcp-servers/http/mcp-server-routes.ts`
- `apps/shared/src/mcp/`
- `apps/frontend/src/features/settings/mcp/`
- Reference: `docs/reference/mcp.md`

A server's card shows its tool identity name, not its stored `name`, whenever
the user set one — see the Environments playbook. Tool namespacing is unaffected:
`tool-naming.ts` still builds every name from the slug.

## Attachments

Open these first:

- `apps/api/src/modules/attachments/application/attachment-storage.ts`
- `apps/api/src/modules/attachments/application/attachment-validation.ts`
- `apps/api/src/modules/attachments/application/runtime-attachment-resolver.ts`
- `apps/api/src/modules/attachments/infrastructure/attachment-repository.ts`
- `apps/api/src/services/providers/core/attachment-content.ts`
- `apps/frontend/src/features/chat/components/MessageParts.tsx`

## Workdir, Git, And GitHub Context

Open these first:

- `apps/api/src/modules/workspaces/`
- `apps/api/src/modules/git/`
- `apps/api/src/modules/github/`
- `apps/shared/src/workspaces/`
- `apps/shared/src/git/`
- `apps/shared/src/github/`
- `apps/frontend/src/features/workspace/`

### API layering

Workspace filesystem browsing and workdir validation run in the runtime via
`workspace.browse` / `workspace.validate`. Hub modules under
`application/directory-browser.ts` and `application/workdir-validation.ts` are
thin RuntimeClient facades that preserve HTTP error types. Path-containment
helpers re-export from `@mangostudio/runtime`; workdir-policy decisions stay in
the hub.

Every git route lives in `http/git-routes.ts` behind `routeWorkdir()` (chat ownership
plus workdir resolution) and `gitWriteError()` (typed failures), and declares the same
`403/404/409/422/500: ApiErrorResponseSchema` set.

- Reads: `application/git-status-service.ts` and `application/git-navigation-service.ts`
  (history, commit details, diffs, `getHeadMessage` for the amend prefill).
- Writes: `application/git-write-service.ts`. Every mutation runs inside
  `runRepoMutation` — which resolves the repo root, takes `withMutationLock` keyed by
  `(environmentId, repoRoot)` (Local uses `local`), and funnels failures through
  `mapWriteFailure` — so two chats rooted in the same repository never touch one
  `.git/index` concurrently.
- Git spawn is owned by the runtime via argv-array-only `git.exec`; the hub
  `infrastructure/git-cli.ts` is a thin RuntimeClient facade that maps
  `git_execution` failures to `GitCliError`. Parsers, mutation locks, and routes stay
  in the hub.
- Failure mapping is per operation: `mapCommitFailure`, `mapBranchSwitchFailure`,
  `mapBranchDeleteFailure` (`not fully merged` → `BRANCH_NOT_MERGED`) and
  `mapRemoteFailure` (auth, non-fast-forward, diverged history).
- `/push` takes `GitPushBodySchema`, whose `force` is the literal `'with-lease'`. A plain
  `--force` is not expressible on the wire and is never constructed.

### Frontend panel

`GitPanel.tsx` is organized around the commit box: branch row → tabs → commit box →
change groups, with the GitHub card collapsed at the bottom.

- `CommitForm.tsx` owns the message state and amend mode; `CommitActions.tsx` owns
  `useCommitActions`, which chains the mutations behind each menu entry and aborts on the
  first failure. Add a new commit variant there, not in the form.
- Unstaged and untracked changes render as one group. `GitDiscardSelection[]` is the unit
  of a discard because a mixed bulk discard needs one call per mode.
- Secondary controls live in menus: the panel header overflow (stash sheet, prune
  preference, refresh), the commit split button, per-group overflow, and per-branch rows.
  All four use `components/ui/Menu.tsx`; the commit button uses
  `components/ui/SplitButton.tsx`. There is no popover library — extend these.
- `git-panel-prefs.ts` persists panel preferences in localStorage, mirroring
  `rail/rail-state.ts`.
- `hooks/use-git-state.ts` is the only place that talks to the API. Every write must add
  an entry to `gitWriteScopes`; the guard test in
  `apps/frontend/tests/unit/hooks/use-git-state.test.ts` fails otherwise.

### Tests

- `apps/api/tests/integration/routes/git-{state,write,navigation}.integration.test.ts`
  drive real temp repositories and skip when git is absent. Their fixtures pin
  `core.hooksPath` so a global `commit-msg` hook cannot rewrite fixture messages.
- `apps/frontend/tests/unit/components/git-panel.test.tsx` mocks the hook module
  wholesale, so a new hook must be added to that mock before the panel can render.

## Prompt Rules

Open these first:

- `apps/api/src/modules/prompt-rules/application/prompt-composer.ts`
- `apps/api/src/modules/prompt-rules/application/rule-file-resolver.ts`
- `apps/api/src/modules/prompt-rules/http/rule-file-routes.ts`
- `apps/frontend/src/components/settings/PromptSettings.tsx`
- `apps/frontend/src/components/settings/RuleFileCard.tsx`

## Settings (App, Provider, Tool)

Open these first:

- `apps/api/src/modules/app-settings/http/app-settings-routes.ts`
- `apps/api/src/modules/app-settings/infrastructure/app-settings-repository.ts`
- `apps/api/src/modules/provider-settings/http/provider-settings-routes.ts`
- `apps/api/src/modules/tool-settings/http/tool-settings-routes.ts`
- `apps/api/src/services/tools/settings-policy.ts`
- `apps/frontend/src/routes/_authenticated/settings/` (settings route tree)
- `apps/frontend/src/components/settings/` (shared panels + `SettingsTabs.tsx`)
- `apps/frontend/src/features/settings/app/`
- `apps/frontend/src/features/settings/external-api/`
- `apps/frontend/src/features/settings/providers/`
- `apps/frontend/src/features/settings/tools/`

## Image Generation

Open these first:

- `apps/api/src/modules/generation/application/generate-image.ts`
- `apps/api/src/services/generated-images/generated-image-storage.ts`
- `apps/api/src/modules/generated-images/infrastructure/generated-image-repository.ts`
- `apps/api/src/services/providers/gemini/image-generation.ts`
- `apps/api/src/services/providers/openai/image-generation.ts`
- `apps/frontend/src/features/gallery/GalleryPage.tsx`
- `apps/frontend/src/features/generation/hooks/use-image-generation.ts`

## Persistence And Database

Open these first:

- `apps/api/src/db/database.ts`
- `apps/api/src/db/types.ts`
- `apps/api/src/db/serializers.ts`
- `apps/api/src/db/migrations/`
- the owning service or route

## Frontend UX, Routing, And State

Open these first:

- `apps/frontend/src/routes/`
- `apps/frontend/src/features/`
- `apps/frontend/src/components/`
- `apps/frontend/src/components/ui/`
- `apps/frontend/src/hooks/`
- `apps/frontend/src/services/`
- `apps/frontend/src/index.css`

## Shared Contracts, Types, And i18n

Open these first:

- `apps/shared/src/contracts/index.ts`
- `apps/shared/src/errors/contracts.ts`
- `apps/shared/src/types/index.ts`
- `apps/shared/src/i18n/pt-BR.ts`
- `apps/shared/src/i18n/en.ts`
- `apps/shared/src/i18n/types.ts`
- the affected API and frontend consumers

## Config, Runtime, And Standalone Build

Open these first:

- `apps/api/src/lib/config.ts`
- `apps/api/src/lib/runtime-paths.ts`
- `apps/api/src/index.ts`
- `.mango/config.toml.example`
- `.mango/.env.example`
- `scripts/build.ts`
- `scripts/test-build.ts` (binary smoke)

The build produces two binaries per platform: `mangostudio` and the
`mangostudio-runtime` execution host, compiled from `apps/runtime/src/cli.ts`. They
carry the same build stamp and ship together in every channel — archives, npm
platform packages, and the Docker images — because the hub resolves the runtime as a
sibling of its own executable and the protocol handshake refuses a version mismatch.

## Out-Of-Process Environments (stdio, WSL, paired WebSocket, Direct URL)

Open these first:

- `apps/runtime/src/cli.ts` (binary entry), `apps/runtime/src/transports/stdio.ts` (NDJSON port)
- `apps/api/src/services/runtime-client/spawn-runtime-child.ts` (spawn, handshake, teardown)
- `apps/api/src/services/runtime-client/runtime-connection-manager.ts` (state machine, backoff)
- `apps/api/src/services/runtime-client/target-paths.ts` (target path style, from the manifest)
- `apps/api/src/lib/runtime-paths.ts` (`resolveRuntimeLaunchCommand`)
- `apps/frontend/src/features/environments/components/AddEnvironmentDialog.tsx`
- Reference: `docs/architecture/hub-runtime.md`

Reconnection is a backoff deadline checked on the next use, not a scheduled timer;
`#markUnavailable` is where a dead runtime becomes `disconnected`. The stdio child's
stdout is protocol-only — anything written to it there desynchronises the stream and
tears the connection down.

WSL is a launcher over that same transport, not a protocol of its own:

- `apps/api/src/modules/environments/domain/wsl-output.ts` (UTF-16LE + localized listing)
- `apps/api/src/modules/environments/application/wsl-detection.ts` (detection service, win32 gate)
- `apps/api/src/modules/environments/http/environment-routes.ts` (`GET /environments/wsl`)
- `apps/api/src/modules/environments/domain/wsl-runtime-release.ts` (argv, scripts, asset names)
- `apps/api/src/modules/environments/infrastructure/wsl-provisioner.ts` (download, verify, install)

A paired WebSocket inverts the direction — the runtime dials the hub — so nothing
in the spawn path applies and the manager is entered through `adopt()` rather than
`connect()`:

- `apps/shared/src/runtime-protocol/chunk.ts` (frames split across 16 KiB messages)
- `apps/shared/src/runtime-protocol/close-codes.ts` (why a socket ended, and whether to redial)
- `apps/runtime/src/transports/websocket.ts` (frame port, send queue, backpressure)
- `apps/runtime/src/connect.ts` (dial loop, backoff, liveness), `apps/runtime/src/runtime-home.ts`
- `apps/api/src/modules/environments/http/runtime-socket-routes.ts` (`/api/runtime`)
- `apps/api/src/modules/environments/domain/pairing-token.ts` (selector + verifier, dial endpoint)
- `apps/api/src/modules/environments/application/runtime-pairing-service.ts`
- `apps/frontend/src/features/environments/components/RuntimePairingPanel.tsx`
- Conformance: `apps/runtime/tests/support/transport-conformance.ts` — a new transport
  supplies a fixture there rather than a suite of its own.

Direct URL inverts it again — the hub dials a listening runtime — so it is a connector
on `connect()`, not `adopt()`, and is not in the dial-in transport set:

- `apps/runtime/src/serve.ts` (`Bun.serve`, bearer upgrade, supersede, `/health`)
- `apps/api/src/services/runtime-client/connect-http-runtime.ts` (hub dial-out)
- `apps/api/src/services/runtime-client/runtime-token-secrets.ts` (OS secret store, hard-fail)
- `apps/api/src/services/runtime-client/http-runtime-url.ts` (http→ws, allow private hosts)
- `apps/frontend/src/features/environments/components/DirectUrlPanel.tsx`

Paths inside a distribution are native Linux paths end to end — there is no
translation layer and none is wanted. What the hub does is *resolve* in the
target's style, from the manifest; see the Paths Across Hosts section of
`hub-runtime.md` before adding anything that touches `~` or a relative path.

## CLI And Server Lifecycle

Covers `serve`, `status`, `stop`, `killserver`, and `doctor`.

Open these first:

- `apps/api/src/index.ts` (CLI entry)
- `apps/api/src/cli/` (argument parsing, dispatch, commands, doctor checks)
- `apps/api/src/server/start-server.ts`
- `apps/api/src/lib/server-state.ts` (PID and port state)
- `apps/api/src/lib/mango-paths.ts`
- Reference: `docs/reference/cli.md`

## Changelog And Release

Open these first:

- `cliff.toml` (git-cliff config; `CHANGELOG.md` is generated, never hand-edited)
- `scripts/changelog.ts`
- `scripts/lib/changelog.ts`
- `scripts/lib/release-version.ts`
- `scripts/lib/prepare-release.ts`
- `scripts/release/prepare-release.ts`
- `scripts/release/pack-npm.ts`
- `scripts/check-versions.ts`
- `packages/cli/`
- `packages/cargo-shim/`
- `.github/workflows/pr-qa-report.yml`, `.github/workflows/release.yml`, `.github/workflows/cargo-shim.yml`
- Reference: `docs/reference/releasing.md`
