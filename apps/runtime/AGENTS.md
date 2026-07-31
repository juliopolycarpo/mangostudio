# Runtime Workspace Guidance

Read `../../AGENTS.md` first. This workspace owns host-machine execution behind
the shared runtime protocol.

- Runtime code may depend on `@mangostudio/shared` and Bun, never `apps/api`.
- Parse runtime-binary environment configuration only in `src/config.ts`.
- Keep protocol payloads serializable; cancellation must travel as a `cancel`
  frame rather than an `AbortSignal` field.
- The binary's stdout is the protocol stream. Never write to it outside a frame
  transport; diagnostics go to stderr, which the hub collects.
- Run runtime tests with `bun run --filter @mangostudio/runtime test:unit`.
