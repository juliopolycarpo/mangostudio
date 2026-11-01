# Settings Architecture

MangoStudio has three independent settings layers, each with its own persistence, API, and frontend module.

## Settings Taxonomy

| Layer                 | What it controls                                                       | Persistence table        | Scope                      |
| --------------------- | ---------------------------------------------------------------------- | ------------------------ | -------------------------- |
| **App Settings**      | Generation defaults, prompt config, context behavior                   | `user_app_settings`      | One blob per user          |
| **Provider Settings** | Per-provider runtime config (reasoning effort, caching, output tokens) | `user_provider_settings` | One blob per user+provider |
| **Tool Settings**     | Per-tool enable/disable and parameter overrides                        | `user_tool_settings`     | One row per user+tool      |

## App Settings

Controls global preferences that apply across all providers and tools.

**Selected stored fields** (the complete contract is [`AppSettingsSchema`](../../apps/shared/src/app-settings/schemas.ts), with [defaults](../../apps/shared/src/app-settings/defaults.ts)):

| Field                | Type                              | Default                |
| -------------------- | --------------------------------- | ---------------------- |
| `promptSettings`     | `PromptSettings`                  | Default system prompts |
| `globalImageQuality` | `'512px' \| '1K' \| '2K' \| '4K'` | `'1K'`                 |
| `thinkingEnabled`    | `boolean`                         | `false`                |
| `reasoningEffort`    | `ReasoningEffort`                 | `'medium'`             |
| `maxToolIterations`  | `number` (1–1000)                 | `1000`                 |
| `contextSettings`    | `ContextSettings`                 | Compaction defaults    |

Theme and language are frontend preferences stored in browser `localStorage`, owned by `apps/frontend/src/hooks/use-theme.tsx` and `use-i18n.tsx`. They are outside `AppSettings`. Other stored groups include multi-agent, chat-title, workspace, Git, chat-display, external API, external-agent and profile settings; use the schema for their shapes.

**API:**

```
GET  /api/settings/app    → Returns AppSettingsResponse (AppSettings + libraryLocationDefaultsPending)
PUT  /api/settings/app    → Merges a patch and returns normalized AppSettingsResponse
```

Which library locations default to on is detected from the agent CLIs installed
on the hub's machine, and the first detection after a hub start can take
seconds. `GET` never waits for it: until a detected value exists it answers the
saved settings over static placeholder defaults with
`libraryLocationDefaultsPending: true`, and publishes an `app` settings
invalidation to each user it answered that way once detection lands. Clients
must not show or write back library-location enablement while the flag is set.
`PUT` always waits for detection, so its answer is never pending and a write
never stores the placeholder.

Settings are stored as a single JSON blob in the `settingsJson` column. On read, `normalizeAppSettings()` handles partial or malformed data by falling back to defaults for any missing or invalid fields.

**The PUT body is a patch, not a snapshot.** Every field is optional; the server
overlays what arrives on the row it already holds, then normalizes. Two things
follow, and both are the point: a client survives every field the schema grows
later instead of being rejected for omitting one it has never heard of, and clients avoid sending unrelated fields. This patch shape does not guarantee
atomic concurrent read/merge/write operations by itself. The repository uses
compare-and-swap on the exact JSON it read, with a fresh private write version
on every save (not `updatedAt`). Concurrent creation uses insert-or-do-nothing;
updates only replace the matching row. A loser returns HTTP 409 with the shared
`ApiErrorResponse` code `CONFLICT`, and does not publish a settings invalidation.
The frontend reports the failed save and fetches current settings; the next
user action rebuilds only its intended patch. It never automatically replays a
stale onboarding or library subtree. A failed refresh keeps the cache
invalidated: onboarding and location writers must read successfully before
building another patch, while auto-save rejects edits and starts another read.
An awaited save also rejects instead of allowing a consent-gated action to
continue without a confirmed write. Queued auto-save bursts based on the
rejected snapshot are discarded and reported as failed.

Existing request and success-response shapes remain compatible; clients must
handle 409 by reading current settings and rebuilding their edit. This is a
server read/merge/write concurrency guarantee, not a client revision
precondition. A request whose repository read starts after another write has
committed can still replace the same complete field, even when its payload
was built earlier. That case remains last-writer-wins; the guarantee rejects
a stale repository snapshot, not every stale client snapshot.

The rule, in full:

- an omitted key keeps whatever is stored;
- a supplied field replaces what was stored under it, whole. An optional member
  the patch leaves out is a clear, not an omission — which is how "the machine
  changed, forget that folder" is said at all;
- arrays replace for the same reason — merging by index would make "remove the
  second rule" inexpressible;
- only the containers _above_ those fields merge: `profileSettings` and one
  profile's entry, whose children have different owners;
- `null` on a key that admits it resets that subtree to its default. That is how
  a whole subtree is cleared, and it works because normalization runs _after_
  the merge.

The unit of a patch is a whole top-level field: send `contextSettings` and you
send all of it, and half a subtree is rejected rather than backfilled with
defaults. A field is addressable more finely only where its parts are
independently owned — `profileSettings.<id>.libraryLocations` and `.onboarding`
are written by different screens, so each is optional on its own.

`appSettingsPatchExcludingProfiles`, `libraryLocationsPatch` and
`onboardingPatch` (`@mangostudio/shared/app-settings`) build the three patches
the frontend sends.

### Prompt Settings (sub-object)

Controls system prompts and rule file configuration:

- `textSystemPrompt` — System prompt for text generation.
- `imageSystemPrompt` — System prompt for image generation.
- `agentsMd` — Content from `AGENTS.md` used as prompt injection.
- `claudeMd` — Content from `CLAUDE.md` used as prompt injection.
- `customRules` — User-defined rule files with path, enabled state, injection role, and send frequency.

### Context Settings (sub-object)

Controls context window behavior:

See [Context Settings](../architecture/context-compaction.md#context-settings-user-configurable) for the current fields and defaults.

## Provider Settings

Controls per-provider runtime behavior. Each provider has a policy that defines which settings are applicable.

**API:**

```
GET  /api/settings/providers              → List of all provider descriptors
GET  /api/settings/providers/:provider    → Single provider descriptor
PUT  /api/settings/providers/:provider    → Update provider settings
```

### Provider Settings Policy

Each provider type has a hardcoded policy in `provider-settings-policy.ts`:

These flags describe MangoStudio configuration support, not all vendor-side behavior. Cursor is deprecated and retained only for existing settings; execution and new setup are closed.

| Provider            | Thinking toggle | Prompt caching | Tools | Structured output |
| ------------------- | --------------- | -------------- | ----- | ----------------- |
| Gemini              | Yes             | Yes            | Yes   | Yes               |
| OpenAI              | Yes             | Yes            | Yes   | Yes               |
| OpenAI-compatible   | No              | No             | Yes   | Yes               |
| Anthropic           | Yes             | Yes            | Yes   | No                |
| DeepSeek            | Yes             | No             | Yes   | No                |
| Cursor (deprecated) | Yes             | No             | Yes   | No                |
| ChatGPT             | Yes             | No             | Yes   | No                |

Settings are normalized against the provider policy on every read and write. For example, Anthropic will always return `structuredOutputSupported: false` regardless of saved data.

### Runtime Settings Shape

Use the schema-derived `ProviderRuntimeSettings` from `@mangostudio/shared/provider-settings`; the canonical [schema](../../apps/shared/src/provider-settings/schemas.ts) includes required `provider` and optional `thinkingEnabled`, `reasoningEffort`, `maxOutputTokens`, `maxToolIterations`, `providerCompactionEnabled`, `promptCachePreference` (`auto` / `stable-prefix` / `off`) and `parallelToolCallsEnabled`.

## Tool Settings

Controls which tools are enabled and their parameter values per user.

**API:**

```
GET  /api/settings/tools              → List all tool descriptors with settings
PUT  /api/settings/tools/:toolName    → Update a tool's settings
```

Each tool row has a dedicated `enabled` column (integer 0/1) and a `parametersJson` blob. Settings are validated against each tool's `parameterDescriptors` at write time — invalid values return HTTP 422.

### Parameter Descriptors

Each tool declares its configurable parameters:

```typescript
interface ToolParameterDescriptor {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  label: string;
  description: string;
  required: boolean;
  defaultValue: unknown;
  options?: Array<{ label: string; value: unknown }>;
  min?: number;
  max?: number;
  modelType?: 'image'; // for catalog-backed model selectors
}
```

## Settings Flow

```
Frontend Component
    │
    ▼
Hook (TanStack Query: useQuery / useMutation)
    │
    ▼
Eden Treaty Client (typed API calls)
    │
    ▼
Elysia Route (auth + TypeBox validation)
    │
    ▼
Application Service
    ├─ Validate (ownership, policy constraints)
    ├─ Normalize (merge with defaults, clamp values)
    ├─ Repository (Kysely upsert)
    │
    ▼
Response (typed via shared contracts)
```

All settings queries use 30-second `staleTime` in TanStack Query. Mutations auto-invalidate their respective list queries on success.

## Migration: localStorage → Database

App settings were originally persisted in the browser's `localStorage` via `useGlobalSettings()`. PR #210 migrated them to a database-backed API:

1. **Shared contracts** — New `app-settings` module with TypeBox schemas and defaults.
2. **API module** — `app-settings` HTTP routes + application service + repository, migration 018.
3. **Frontend migration** — `useGlobalSettings()` refactored from `localStorage` reads/writes to TanStack Query backed by the API.

Provider and tool settings were always database-backed from their introduction (PRs #181, #186, #187).

## Adding a New Setting

1. Define the type and schema in `apps/shared/src/<module>/`.
2. Add the field to the shared contract and defaults.
3. Update the API repository to read/write the new field.
4. Update the application service normalization to handle partial data.
5. Add the API route if needed.
6. Add the frontend hook and UI component.
7. If the setting affects behavior at generation time, wire it into the appropriate service (e.g., `stream-text-turn.ts` reads from `getAppSettings()` / `getEnabledToolRuntime()`).
