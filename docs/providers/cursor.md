# Cursor Provider

Cursor is integrated as a first-class MangoStudio provider that runs the **local Cursor SDK agent** against a MangoStudio-managed workspace. It is an adapter, not a thin SDK wrapper: MangoStudio owns connector storage, model discovery, chat orchestration, tool policy, and streaming, while the Cursor SDK runs the local coding-agent loop in a Node.js sidecar.

## Provider Type

- **Provider ID:** `cursor`
- **SDK:** `@cursor/sdk` (TypeScript)
- **Runtime:** Node.js `>= 22.13` sidecar subprocess (required for agent streaming)
- **Secrets:** `CURSOR_API_KEY` / `[cursor_api_keys]` in `~/.mango/config.toml`

## Requirements

- A valid Cursor API key from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations)
- **Node.js 22.13+** on the host machine. MangoStudio's API runs on Bun, but the Cursor SDK local agent stream currently requires Node.js. When Node is missing, the Cursor connector appears disabled in Settings with a hint.

## Workspace

Two directories matter for Cursor runs:

- **Project workspace** (`cursor.workspace_dir` / `CURSOR_WORKSPACE_DIR`): the user's project root. MangoStudio injects this into the agent prompt so routed file/shell tools use absolute paths under this directory. Defaults to MangoStudio's current working directory.
- **Managed agent cwd** (`~/.mango/cursor-agent`): where the Cursor SDK local agent runs. MangoStudio installs `.cursor/hooks.json` here to hard-deny Cursor built-in tools.

## Model Discovery

`Cursor.models.list({ apiKey })` runs in-process on the Bun API for connector validation and catalog discovery. Auth failures propagate as validation errors; transient outages may fall back to `composer-2.5` and `auto`. An empty model list is treated as an error instead of silently enabling fallback models.

## Capabilities

Cursor models expose `internalAgentTools: true` in the catalog to indicate the SDK runs its own agent tool loop internally. MangoStudio does **not** expose `tools: true` or implement `generateAgentTurnStream` for this provider — tool activity from routed MangoStudio tools appears in chat as system events.

## Generation Path

1. Chat requests resolve to the `cursor` provider via enabled connector models.
2. MangoStudio flattens system prompt, workspace root, history, and user prompt into a single agent prompt.
3. MangoStudio ensures managed hooks at `~/.mango/cursor-agent/.cursor/hooks.json` that deny all Cursor built-in tools (`failClosed: true`), allowing only the SDK `custom-user-tools` MCP server.
4. A Node sidecar (`cursor-sidecar/run-agent.mjs`) runs `Agent.create` + `agent.send` + `run.stream()` with `local.cwd` set to the managed agent directory and `settingSources: ['project']`.
5. Allowlisted MangoStudio tools are passed as Cursor SDK `customTools`. When the model invokes one, the sidecar emits a `tool_request` over stdout; the API executes it via `executeTool` (registry, settings, env policy) and writes a `tool_response` back over stdin.
6. NDJSON events are mapped to MangoStudio `StreamingChunk` values (`text`, `thinking`, `tool_call`, `error`). Tool calls are surfaced in chat as `cursor_internal_tool_call` system events.

Cursor runs its own agent loop for model reasoning; MangoStudio does **not** implement `generateAgentTurnStream` for this provider. Side effects are governed by the MangoStudio tool registry, not Cursor built-ins.

## Security Posture

- API keys follow the standard connector secret backends (OS secret store, `config.toml`, `.env`).
- **MangoStudio's tool registry is the policy authority.** Agent allowlists and per-tool settings control which tools are exposed as Cursor `customTools` and which calls reach `executeTool`.
- **Cursor built-in tools are hard-denied** via managed `.cursor/hooks.json` in `~/.mango/cursor-agent`. Built-in shell, read, write, grep, and other SDK tools cannot execute; only routed MangoStudio tools (via `custom-user-tools`) can run.
- Tool execution happens in the API process through `executeTool`, inheriting MangoStudio timeouts, path policies, shell env filtering, and the full registry implementation — not a duplicated executor in the sidecar.
- The configured project workspace is passed in the prompt; file/shell tools resolve paths through MangoStudio's own policies independent of the SDK agent cwd.

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
