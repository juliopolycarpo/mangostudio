# Tools System

MangoStudio supports provider-agnostic tool calling during chat turns. Models can call tools, the system executes them, and results are fed back to the model in a loop.

## Architecture

```
HTTP Layer (tool-settings-routes.ts)
    │
Application Layer (tool-settings-service.ts)
    │── uses ──→ Registry (registry.ts)
    │── uses ──→ Settings Policy (settings-policy.ts)
    │── uses ──→ Repository (tool-settings-repository.ts)
                    │
                DB: user_tool_settings
                    │
Tools Layer (types.ts + registry.ts)
    │── registers ──→ Builtins (generate-image.ts, get-current-datetime.ts)
    │
Provider Layer (tool-mapper.ts) ──→ Provider-specific wire formats
```

## Tool Lifecycle

1. **Registration** — Tools self-register at import time via `registerTool()`. Built-in tools call this at module load.
2. **Settings resolution** — At chat time, `getEnabledToolRuntime()` loads user tool settings from DB, merges with defaults, and produces enabled `ToolDefinition[]`.
3. **Wire format mapping** — `tool-mapper.ts` converts `ToolDefinition[]` to provider-specific format (OpenAI function tools, Gemini function declarations, etc.).
4. **Model calls tool** — The provider streams `tool_call_started` / `tool_call_arguments_delta` / `tool_call_completed` events.
5. **Execution** — `executeTool()` looks up the tool, checks it is enabled for the user, merges settings, and runs the executor.
6. **Result feeding** — Tool results are serialized and fed back to the model in the next loop iteration.
7. **Loop iteration** — Steps 4–6 repeat until the model produces a text response or the max iteration limit is reached.

## Core Types

### ToolDefinition

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema; // JSON Schema for the tool's arguments
}
```

### RegisteredTool

```typescript
interface RegisteredTool {
  definition: ToolDefinition;
  buildDefinition?: (settings: EffectiveToolSettings) => ToolDefinition;
  settings: ToolSettingsMetadata;
  execute: (args: unknown, context: ToolContext) => Promise<unknown>;
}
```

### ToolSettingsMetadata

```typescript
interface ToolSettingsMetadata {
  title: string;
  description: string;
  category: 'system' | 'image' | 'interaction';
  enabledByDefault: boolean;
  canDisable: boolean;
  defaultParameters: Record<string, unknown>;
  parameterDescriptors: ToolParameterDescriptor[];
}
```

## Built-in Tools

Chats bind a server-side working directory. Filesystem tools default omitted
`path` / `cwd` arguments to the bound directory, resolve relative arguments
against it, and the agent system prompt announces it. A chat with no bound
directory falls back to the API process working directory when `cwd` is
omitted, and tools such as `list_directory` and `grep` still require an
explicit `path`. When restriction is enabled, path containment policy applies
to routed tools.

### `generate_image`

Creates one or more images via image generation models during a text chat turn.

- **Tool name:** `generate_image`
- **Category:** `image`
- **Parameters:** `prompt` (required), `count` (1–4), `quality`, `model`
- **Settings:** `timeoutSeconds` (5s–600s, default 30s), `maxImagesPerCall`, `defaultQuality`, `defaultModel`, `letAiDecideQuality`
- **Execution:** Plans images via `createGenerateImageToolPlan()`, streams per-image outcomes, summarizes into a single result. Honors the configured `timeoutSeconds` execution budget.

### `get_current_datetime`

Returns the current date and time in a requested timezone and locale.

- **Tool name:** `get_current_datetime`
- **Category:** `system`
- **Parameters:** `timezone` (IANA, e.g. `America/Sao_Paulo`), `locale` (BCP 47, e.g. `pt-BR`)
- **Execution:** Validates timezone, formats via `Intl.DateTimeFormat`, returns ISO UTC + localized datetime + offset.

### `read_file`

Reads the contents of a text file from disk with line-numbered output.

- **Tool name:** `read_file`
- **Category:** `system`
- **Parameters:**
  - `path` (required, absolute, `~`-prefixed, or relative to the chat working directory)
  - `startLine` (optional, 1-based; default `1`)
  - `maxLines` (optional; default `2000`, max `5000`)
- **Settings:** `allowedPaths`, `deniedPaths` (path lists; enforced by `resolveAndValidatePath`)
- **Execution:** Reads through a single file descriptor (with a 10 MiB size ceiling), rejects
  NUL-sniffed binary files, and returns line-numbered (`cat -n` style) content for the
  requested window. Whole-file `sha256` is always recorded for the freshness ledger, even
  on a partial read. Result shape:
  `{ content, path, size, sha256, totalLines, startLine, endLine, truncated }`.
  Per-line and window byte caps may set `truncated` and append a notice to use
  `startLine`/`maxLines` for more.

### `list_directory`

Lists files and directories at a path.

- **Tool name:** `list_directory`
- **Category:** `system`
- **Parameters:** `path` (required, absolute, `~`-prefixed, or relative to the chat working directory)
- **Settings:** `allowedPaths`, `deniedPaths`
- **Execution:** Calls `readdir(path, { withFileTypes: true })` and returns `{ path, entries: { name, type }[] }`.

### `glob`

Finds filesystem paths matching a glob pattern, evaluated by `Bun.Glob`.

- **Tool name:** `glob`
- **Category:** `system`
- **Parameters:** `pattern` (required, supports `*`, `**`, `?`, `[]`, `{a,b}`, `!`), `cwd` (optional base directory; absolute, `~`-prefixed, or relative to the chat working directory; defaults to the chat working directory, otherwise `process.cwd()`)
- **Settings:** `allowedPaths`, `deniedPaths`, `maxResults` (1–5,000; default 200), `includeDotfiles` (default `false`), `absolute` (default `false`)
- **Execution:** Streams matches with `new Bun.Glob(pattern).scan({ cwd, dot, absolute, onlyFiles: false })`, stops at the cap, and reports `truncated`.

### `grep`

Searches files for lines matching a regular expression.

- **Tool name:** `grep`
- **Category:** `system`
- **Parameters:** `pattern` (required regex), `path` (required file or directory; absolute, `~`-prefixed, or relative to the chat working directory), `glob` (optional file filter for directory searches), `caseInsensitive`
- **Settings:** `allowedPaths`, `deniedPaths`, `maxResults` (1–5,000; default 100), `maxMatchesPerFile` (default 20), `maxFileSizeBytes` (default 1 MB), `includeDotfiles`
- **Safety:** Files containing a null byte in the first 1 KB are treated as binary and skipped; files above `maxFileSizeBytes` are skipped. The regex is compiled with `new RegExp` and rejected via `GrepPatternError` if invalid.
- **Execution:** When `path` is a directory, walks it with `Bun.Glob` (filtered by the optional `glob`); for each candidate, reads with `Bun.file().text()`, splits by newline, and records `{ file, line, text }` matches.

### `bash` / `zsh` / `powershell`

Run a shell command and return its captured `stdout`, `stderr`, exit code, and timing. The three tools share one implementation (`buildShellTool`) and only differ by interpreter.

- **Tool names:** `bash`, `zsh`, `powershell`
- **Category:** `system`
- **Parameters:** `command` (required), `cwd` (optional working directory; absolute, `~`-prefixed, or relative to the chat working directory)
- **Settings:** `timeoutSeconds` (5s–600s, default 30s), `maxOutputBytes` (1KB–1MB per stream, default 100KB)
- **Availability:** Registered at import time only when the interpreter exists — `bash`/`zsh` via `Bun.which`, `powershell` only on Windows (`pwsh` then `powershell`). Unavailable shells are never offered to models.
- **Safety:** Disabled by default (`enabledByDefault: false`); requires explicit opt-in. The process is killed with `SIGKILL` after the configured timeout, and per-stream output is capped at `maxOutputBytes` (flagged via `truncated`). Parent abort (user cancel or stream teardown) is tracked separately from timeout and does not surface as a timeout error.
- **Execution:** `runShellCommand()` spawns the interpreter with `Bun.spawn` (`bash -c` / `zsh -c` / `powershell -NoProfile -NonInteractive -Command`), enforces the timeout with an owned timer (not Bun's spawn timeout), reads both streams under the byte cap, and returns a structured `ShellCommandResult` with a `termination` field (`exited`, `timed_out`, `aborted`, or `signalled`).

## Settings Policy

The settings policy (`settings-policy.ts`) provides pure functions for:

| Function                                       | Purpose                                                   |
| ---------------------------------------------- | --------------------------------------------------------- |
| `getDefaultToolSettings(tool)`                 | Returns defaults from tool metadata                       |
| `mergeToolSettings(tool, saved?, updates?)`    | Three-way merge: defaults < saved < overrides             |
| `normalizeToolParameters(tool, params)`        | Validates parameter names, types, min/max, allowed values |
| `getToolDefinitionsForTools(tools, settings?)` | Filters enabled tools and produces definitions            |

Parameter normalization throws `ToolParameterError` with a descriptive message on invalid values. The `executeTool()` function catches this via `getSafeEffectiveToolSettings()` and falls back to defaults to prevent corrupted saved settings from breaking tool execution.

Long-running builtins (`bash`, `zsh`, `powershell`, `generate_image`) expose a `timeoutSeconds` setting (5–600, default 30). The chat execution layer reads this value and cancels the tool call when the budget is exceeded; shell tools also forward the abort signal so timed-out or cancelled child processes are killed instead of orphaned. Shell tools distinguish timeout from parent abort in `ShellCommandResult.termination` so only genuine timeouts surface the timeout error message. Tools without `timeoutSeconds` keep the 30-second default.

## Tool Settings API

### `GET /api/settings/tools`

Returns all registered tools with their effective settings for the current user.

Response: `ToolSettingsListResponse`

```typescript
{
  tools: ToolSettingsDescriptor[];
}
```

### `PUT /api/settings/tools/:toolName`

Updates a tool's settings (enabled state and parameters).

Request: `UpdateToolSettingsBody`

```typescript
{
  enabled?: boolean;
  parameters?: Record<string, unknown>;
}
```

Returns 422 with `ToolSettingsError` if parameters are invalid or the tool cannot be disabled.

## Tool Mapper

`tool-mapper.ts` converts internal `ToolDefinition` shapes to provider wire formats:

| Provider            | Mapper                           | Format                                                        |
| ------------------- | -------------------------------- | ------------------------------------------------------------- |
| OpenAI Responses    | `toolDefsToResponsesAPI()`       | `{ type: 'function', name, description, parameters, strict }` |
| Gemini Interactions | `toolDefsToGeminiInteractions()` | `{ name, description, parameters }`                           |
| OpenAI-compatible   | `toolDefsToChatCompletions()`    | `ChatCompletionTool[]`                                        |

OpenAI Responses API applies `strict: true` when the schema satisfies strict mode requirements (`type: object`, `additionalProperties: false`, all properties required, no `oneOf`/`anyOf`/`allOf`/`not`/`$ref`).

## Adding a New Tool

1. Create the tool file in `apps/api/src/services/tools/builtin/`.
2. Define `ToolDefinition`, `ToolSettingsMetadata`, and the `execute` function.
3. Call `registerTool()` to self-register at import time.
4. Import the tool in `apps/api/src/services/tools/index.ts` to trigger registration.
5. If the tool needs settings-aware behavior, provide a `buildDefinition` callback.
6. Add TypeBox schemas for request/response in shared contracts if the tool has its own API surface.
7. Write unit tests for the tool executor and the settings merge behavior.

### Minimal Example

```typescript
import { registerTool } from '../registry';
import type { RegisteredTool, ToolContext } from '../types';

const MY_TOOL: RegisteredTool = {
  definition: {
    name: 'my_tool',
    description: 'Does something useful.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input value' },
      },
      required: ['input'],
    },
  },
  settings: {
    title: 'My Tool',
    description: 'A custom tool for specific tasks.',
    category: 'interaction',
    enabledByDefault: true,
    canDisable: true,
    defaultParameters: {},
    parameterDescriptors: [],
  },
  execute: async (args, context) => {
    const { input } = args as { input: string };
    return { result: `Processed: ${input}` };
  },
};

registerTool(MY_TOOL);
```
