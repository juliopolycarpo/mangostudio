# Cursor Provider

Cursor is integrated as a first-class MangoStudio provider that runs the **local Cursor SDK agent** against a MangoStudio-managed workspace. It is an adapter, not a thin SDK wrapper: MangoStudio owns connector storage, model discovery, chat orchestration, tool policy, and streaming, while the Cursor SDK runs the local coding-agent loop in a Node.js sidecar.

## Provider Type

- **Provider ID:** `cursor`
- **SDK:** `@cursor/sdk` (TypeScript), loaded only inside the Node sidecar (see [Source boundary](#source-boundary))
- **Runtime:** Node.js `>= 22.13` sidecar subprocess (model RPC, validation, and agent streaming)
- **Secrets:** `CURSOR_API_KEY` / `[cursor_api_keys]` in `~/.mango/config.toml`

## Requirements

- A valid Cursor API key from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations)
- **Node.js 22.13+** on the host machine. MangoStudio's API runs on Bun and never imports `@cursor/sdk`; the sidecar subprocess requires Node.js. When Node is missing, the Cursor connector appears disabled in Settings with a hint.

## Workspace

Two directories matter for Cursor runs:

- **Project workspace** (`cursor.workspace_dir` / `CURSOR_WORKSPACE_DIR`): the user's project root. MangoStudio injects this into the agent prompt so routed file/shell tools use absolute paths under this directory. Defaults to MangoStudio's current working directory.
- **Managed agent cwd** (`~/.mango/cursor-agent`): where the Cursor SDK local agent runs. MangoStudio installs `.cursor/hooks.json` here to hard-deny Cursor built-in tools.

## Model Discovery

Connector validation and catalog discovery use **short-lived Node sidecar RPC**, not in-process Bun calls. The Bun API spawns `cursor-sidecar/run-agent.mjs` with `list_models` or `validate_api_key`; the sidecar calls `Cursor.models.list({ apiKey })` inside Node.

Auth failures propagate as validation errors; transient outages may fall back to static `composer-2.5` and `auto` models. An empty model list is treated as an error instead of silently enabling fallback models.

## Capabilities

Cursor models expose **`tools: true`** and **`internalAgentTools: true`** in the catalog: the SDK runs its own agent tool loop inside the sidecar, while MangoStudio exposes allowlisted registry tools as Cursor SDK `customTools` and executes them via `executeTool` in the API process.

Default chat routing uses **`generateAgentTurnStream`**. The provider maps sidecar output to standard `AgentEvent` values (`assistant_text_delta`, `reasoning_delta`, `tool_call_started` / `tool_call_completed`, `tool_result`, `turn_completed`, `turn_error`), so routed tools appear as normal tool parts in the UI. The orchestrator completes in a **single iteration** because the sidecar emits `tool_result` events and the provider rejects follow-up `toolResults` from the orchestrator.

The provider still implements **`generateTextStream`** as a secondary path (legacy streaming chunks). That path can surface `cursor_internal_tool_call` system events and does not share the same tool-budget behavior as `generateAgentTurnStream`; normal chat does not use it when `generateAgentTurnStream` is available.

## Generation Path

1. Chat requests resolve to the `cursor` provider via enabled connector models.
2. MangoStudio flattens system prompt, workspace root, history, and user prompt into a single agent prompt.
3. MangoStudio ensures managed hooks at `~/.mango/cursor-agent/.cursor/hooks.json` that deny all Cursor built-in tools (`failClosed: true`), allowing only the SDK `custom-user-tools` MCP server.
4. A Node sidecar (`cursor-sidecar/run-agent.mjs`) runs `Agent.create` + `agent.send` + `run.stream()` with `local.cwd` set to the managed agent directory and `settingSources: ['project']`.
5. Allowlisted MangoStudio tools are passed as Cursor SDK `customTools`. When the model invokes one, the sidecar emits a `tool_request` over stdout; the API executes it via `executeTool` (registry, settings, env policy) and writes a `tool_response` back over stdin.
6. Sidecar NDJSON is mapped to **`AgentEvent`** items for `generateAgentTurnStream`. User cancellation forwards to the sidecar; **`maxToolIterations`** caps custom-tool RPCs (over budget aborts the sidecar and yields a turn error). Unresolved tool calls receive synthetic error `tool_result` events before `turn_completed`.

Side effects are governed by the MangoStudio tool registry, not Cursor built-ins.

## Source boundary

Production code must not import `@cursor/sdk` in the Bun API process. The only allowed import site is `apps/api/src/services/providers/cursor/sidecar/` (today `run-agent.mjs`). Keeping the SDK out of the compiled Bun binary avoids dynamic `require()` / native resolution issues that broke standalone builds on some platforms. A repo test scans `apps/api/src` and fails if `@cursor/sdk` appears outside that directory.

## Security Posture

- API keys follow the standard connector secret backends (OS secret store, `config.toml`, `.env`).
- **MangoStudio's tool registry is the policy authority.** Agent allowlists and per-tool settings control which tools are exposed as Cursor `customTools` and which calls reach `executeTool`.
- **Cursor built-in tools are hard-denied** via managed `.cursor/hooks.json` in `~/.mango/cursor-agent`. Built-in shell, read, write, grep, and other SDK tools cannot execute; only routed MangoStudio tools (via `custom-user-tools`) can run.
- Tool execution happens in the API process through `executeTool`, inheriting MangoStudio timeouts, path policies, shell env filtering, and the full registry implementation — not a duplicated executor in the sidecar.
- The configured project workspace is passed in the prompt; file/shell tools resolve paths through MangoStudio's own policies independent of the SDK agent cwd.

## Standalone Builds

**Current layout:** binary releases vendor a self-contained `cursor-sidecar/` **sibling** to the executable (not embedded inside the binary):

```
<platform>/
  mangostudio
  cursor-sidecar/
    run-agent.mjs
    node_modules/@cursor/sdk             # platform-independent SDK JS
    node_modules/@cursor/sdk-<platform>  # native agent + ripgrep binaries
    node_modules/<js deps…>
```

`@cursor/sdk` cannot be bundled — its dist loads chunks via dynamic `require()` and resolves its native runtime through `createRequire(import.meta.url)` — so the real package tree ships on disk (see `scripts/lib/cursor-sidecar.ts`). Each platform archive carries only its own native package; Bun refuses to install off-host `os`/`cpu` packages, so cross-compiled targets fetch theirs straight from the npm registry at build time.

**MangoStudio never ships a Node.js runtime.** The sidecar runs under the user's own Node.js `>= 22.13`, which must be installed separately on the host. Platforms without a Cursor native package (for example `windows-arm64` and the musl variants beyond glibc reach) skip the sidecar entirely, and the connector reports as unavailable there.

### Distribution

Release archives (`tar.gz`/`zip`) and the per-platform npm packages carry the `cursor-sidecar/` tree next to the binary whenever the build produced one, so installs on a host with Node.js can run the Cursor connector.

**`cargo binstall mangostudio`** installs only the application binary and **omits** `cursor-sidecar/`, so the Cursor provider is unavailable on binstall installs. Use the shell installer or `cargo install mangostudio` for the full sidecar tree.

Docker images intentionally omit the sidecar: the images ship no Node.js runtime, so the connector reports as unavailable inside a container regardless.

## Troubleshooting

When the Cursor connector is disabled in **Settings → Connectors**, the add-connector
modal shows a reason-specific hint. Common cases:

| Symptom                             | Likely cause                                                                          | Fix                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `node` not found                    | Node.js not installed or not on `PATH`                                                | Install Node.js **22.13+**                                                         |
| Version too old                     | Node below 22.13                                                                      | Upgrade Node.js                                                                    |
| Sidecar / SDK missing or incomplete | Broken or partial install                                                             | Reinstall MangoStudio                                                              |
| Native runtime missing              | Platform package absent from sidecar                                                  | Reinstall MangoStudio on a supported platform                                      |
| Platform unsupported                | No Cursor native package (e.g. `windows-arm64`, `linux-x64-musl`, `linux-arm64-musl`) | Use a supported OS/arch; Cursor does not publish native runtimes for these targets |

Run the CLI diagnostics checklist:

```bash
mangostudio doctor              # Cursor section when a connector is configured
mangostudio doctor --all        # always include Cursor chain checks
mangostudio doctor --all --cursor-probe   # plus live sidecar validate_api_key probe
```

`--cursor-probe` spawns the sidecar with an invalid API key. An auth rejection
means the Node → sidecar → SDK chain reached the Cursor SDK successfully.
