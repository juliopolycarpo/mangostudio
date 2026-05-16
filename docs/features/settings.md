# Settings Architecture

MangoStudio has three independent settings layers, each with its own persistence, API, and frontend module.

## Settings Taxonomy

| Layer                 | What it controls                                                       | Persistence table        | Scope                      |
| --------------------- | ---------------------------------------------------------------------- | ------------------------ | -------------------------- |
| **App Settings**      | Theme, language, generation defaults, prompt config, context behavior  | `user_app_settings`      | One blob per user          |
| **Provider Settings** | Per-provider runtime config (reasoning effort, caching, output tokens) | `user_provider_settings` | One blob per user+provider |
| **Tool Settings**     | Per-tool enable/disable and parameter overrides                        | `user_tool_settings`     | One row per user+tool      |

## App Settings

Controls global preferences that apply across all providers and tools.

**Stored fields:**

| Field                | Type                              | Default                |
| -------------------- | --------------------------------- | ---------------------- |
| `promptSettings`     | `PromptSettings`                  | Default system prompts |
| `globalImageQuality` | `'512px' \| '1K' \| '2K' \| '4K'` | `'1K'`                 |
| `thinkingEnabled`    | `boolean`                         | `true`                 |
| `reasoningEffort`    | `ReasoningEffort`                 | `'medium'`             |
| `maxToolIterations`  | `number` (1–1000)                 | `1000`                 |
| `contextSettings`    | `ContextSettings`                 | Compaction defaults    |

**API:**

```
GET  /api/settings/app    → Returns AppSettings
PUT  /api/settings/app    → Updates and returns normalized AppSettings
```

Settings are stored as a single JSON blob in the `settingsJson` column. On read, `normalizeAppSettings()` handles partial or malformed data by falling back to defaults for any missing or invalid fields.

### Prompt Settings (sub-object)

Controls system prompts and rule file configuration:

- `textSystemPrompt` — System prompt for text generation.
- `imageSystemPrompt` — System prompt for image generation.
- `agentsMd` — Content from `AGENTS.md` used as prompt injection.
- `claudeMd` — Content from `CLAUDE.md` used as prompt injection.
- `customRules` — User-defined rule files with path, enabled state, injection role, and send frequency.

### Context Settings (sub-object)

Controls context window behavior:

- `compactionEnabled` / `summarizationEnabled` — Toggle compaction features.
- `compactionThreshold` — Percentage at which compaction is offered (default: 85).
- `compactionSummaryModelId` — Model used for summarization.

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

| Provider          | Thinking | Prompt Caching | Tools         | Structured Output |
| ----------------- | -------- | -------------- | ------------- | ----------------- |
| Gemini            | Yes      | No             | Yes           | Limited           |
| OpenAI            | Yes      | No             | Yes           | Yes               |
| OpenAI-compatible | Depends  | Depends        | Yes           | Depends           |
| Anthropic         | Yes      | Yes            | Yes           | No                |
| DeepSeek          | Yes      | Yes            | Yes (v4 only) | No                |

Settings are normalized against the provider policy on every read and write. For example, Anthropic will always return `structuredOutputSupported: false` regardless of saved data.

### Runtime Settings Shape

```typescript
interface ProviderRuntimeSettings {
  thinkingEnabled?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxOutputTokens?: number;
  maxToolIterations?: number;
  promptCachePreference?: 'auto' | 'enabled' | 'disabled';
}
```

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
