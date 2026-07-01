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

The agent runs with tools enabled and **without** the Cursor sandbox so MangoStudio's own allowlists and upcoming secure sandbox can govern side effects.

## Model Discovery

`Cursor.models.list({ apiKey })` runs in-process on the Bun API for connector validation and catalog discovery. Fallback models include `composer-2.5` and `auto`.

## Generation Path

1. Chat requests resolve to the `cursor` provider via enabled connector models.
2. MangoStudio flattens system prompt + history + user prompt into a single agent prompt.
3. A Node sidecar (`cursor-sidecar/run-agent.mjs`) runs `Agent.create` + `agent.send` + `run.stream()`.
4. NDJSON events are mapped to MangoStudio `StreamingChunk` values (`text`, `thinking`, `tool_call`, `error`).

Cursor runs its own agent loop; MangoStudio does **not** implement `generateAgentTurnStream` for this provider.

## Security Posture

- API keys follow the standard connector secret backends (OS secret store, `config.toml`, `.env`).
- Local agents can read/edit files and run shell commands in the configured workspace.
- MangoStudio relies on its tool allowlists and sandbox roadmap rather than Cursor's optional sandbox.

## Standalone Builds

Binary builds copy `cursor-sidecar/` next to the executable (similar to the frontend `public/` sidecar). Node.js must still be installed separately on the host.
