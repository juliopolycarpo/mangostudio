# Cursor Provider

Cursor is integrated as a first-class MangoStudio provider that runs the **local Cursor SDK agent** against your workspace. It is an adapter, not a thin SDK wrapper: MangoStudio owns connector storage, model discovery, chat orchestration, and streaming, while the Cursor SDK runs the full local coding-agent loop in a Node.js sidecar.

## Provider Type

- **Provider ID:** `cursor`
- **SDK:** `@cursor/sdk` (TypeScript)
- **Runtime:** Node.js `>= 22.13` sidecar subprocess (required for agent streaming)
- **Secrets:** `CURSOR_API_KEY` / `[cursor_api_keys]` in `~/.mango/config.toml`

## Requirements

- A valid Cursor API key from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations)
- **Node.js 22.13+** on the host machine. MangoStudio's API runs on Bun, but the Cursor SDK local agent stream currently requires Node.js. When Node is missing, the Cursor connector appears disabled in Settings with a hint.

## Workspace

Local agents run against a configurable workspace directory:

- Default: MangoStudio's current working directory
- Override via `CURSOR_WORKSPACE_DIR` or `[cursor] workspace_dir` in `~/.mango/config.toml`

The agent runs with Cursor SDK tools enabled and **without** the Cursor sandbox. MangoStudio forwards enabled `bash`, `zsh`, and `powershell` tools from the active agent as Cursor custom tools, including MangoStudio timeout, output caps, and the shell environment allow/deny policy; Cursor's built-in local tools remain governed by the configured workspace and Cursor runtime.

## Model Discovery

`Cursor.models.list({ apiKey })` runs in-process on the Bun API for connector validation and catalog discovery. Auth failures propagate as validation errors; transient outages may fall back to `composer-2.5` and `auto`. An empty model list is treated as an error instead of silently enabling fallback models.

## Capabilities

Cursor models expose `internalAgentTools: true` in the catalog to indicate the SDK runs its own agent tool loop internally. MangoStudio does **not** expose `tools: true` or implement `generateAgentTurnStream` for this provider — internal tool activity appears in chat as system events instead.

## Generation Path

1. Chat requests resolve to the `cursor` provider via enabled connector models.
2. MangoStudio flattens system prompt + history + user prompt into a single agent prompt.
3. A Node sidecar (`cursor-sidecar/run-agent.mjs`) runs `Agent.create` + `agent.send` + `run.stream()`.
4. Enabled MangoStudio shell tools are passed to the sidecar as Cursor SDK custom tools.
5. NDJSON events are mapped to MangoStudio `StreamingChunk` values (`text`, `thinking`, `tool_call`, `error`). Internal tool calls are surfaced in chat as `cursor_internal_tool_call` system events.

Cursor runs its own agent loop; MangoStudio does **not** implement `generateAgentTurnStream` for this provider.

## Security Posture

- API keys follow the standard connector secret backends (OS secret store, `config.toml`, `.env`).
- Local agents can read/edit files and run shell commands in the configured workspace.
- MangoStudio's shell tool allowlist controls which MangoStudio shell custom tools are exposed to Cursor.
- Each forwarded shell tool carries a resolved environment filtered by its `allowedEnvVars`/`deniedEnvVars` policy. The env is computed in the API process (before the sidecar's own environment is stripped of secrets), so allow-listed values reach the command while auto-detected and explicitly denied secrets do not.
- Cursor's built-in local tools are not routed through MangoStudio's tool registry; side effects are governed by the configured workspace and Cursor runtime unless Cursor sandboxing is enabled in a future change.

## Standalone Builds

Binary builds vendor a self-contained `cursor-sidecar/` beside the executable (similar to the frontend `public/` sidecar):

```
<platform>/
  mangostudio
  public/
  cursor-sidecar/
    run-agent.mjs
    node_modules/@cursor/sdk             # platform-independent SDK JS
    node_modules/@cursor/sdk-<platform>  # native agent + ripgrep binaries
    node_modules/<js deps…>
```

`@cursor/sdk` cannot be bundled — its dist loads chunks via dynamic `require()` and resolves its native runtime through `createRequire(import.meta.url)` — so the real package tree ships on disk (see `scripts/lib/cursor-sidecar.ts`). Each platform archive carries only its own native package; Bun refuses to install off-host `os`/`cpu` packages, so cross-compiled targets fetch theirs straight from the npm registry at build time.

**MangoStudio never ships a Node.js runtime.** The sidecar runs under the user's own Node.js `>= 22.13`, which must be installed separately on the host. Platforms without a Cursor native package (for example `windows-arm64` and the musl variants beyond glibc reach) skip the sidecar entirely, and the connector reports as unavailable there.

### Distribution

Release archives (`tar.gz`/`zip`) and the per-platform npm packages carry the `cursor-sidecar/` tree next to the binary whenever the build produced one, so installs on a host with Node.js can run the Cursor connector. Docker images intentionally omit the sidecar: the images ship no Node.js runtime, so the connector reports as unavailable inside a container regardless.
