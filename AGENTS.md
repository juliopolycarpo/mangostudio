# Repository Guidelines

`AGENTS.md` is the canonical root instruction file for this repository.
Workspace-level `AGENTS.md` files must stay short and contain only workspace-specific deltas.

## Command Guidelines

1 - **Always assume/use**: `bun` or `bunx`
2 - **Never use**: `npm`, `npx`, `pnpm` or `yarn`

## Working Loop

1. Read this file, then only the relevant workspace `AGENTS.md`.
2. Start from the closest entrypoint to the task: route, component, hook, service, contract, or test.
3. Trace one layer outward at a time instead of scanning the whole repository.
4. Run the smallest relevant validation first, then expand only if the change is broad.
5. `docs/reference/agent-playbooks.md` is the file map: open the one section matching the task when you need entry points instead of a starting guess.

Useful docs:

- `docs/architecture/overview.md` — workspace map and API module layering
- `docs/architecture/hub-runtime.md` — hub/runtime ownership and protocol boundary
- `docs/protocol/` — Mango Protocol guides; `packages/protocol/AGENTS.md` is its contributor guide
- `docs/architecture/external-agents.md` — hosting vendor CLIs: ownership, discovery, permissions
- `docs/architecture/frontend-build.md` — how the frontend bundle is built, served, and embedded
- `docs/reference/testing.md` — test taxonomy and harness rules
- `docs/reference/agent-playbooks.md` — detailed file maps by feature area
- `docs/reference/releasing.md` — changelog (`bun run changelog`) and release pipeline
- `scripts/README.md` — the Bun-native automation toolkit

## Global Rules

- Use Bun commands from the monorepo root.
- Keep changes scoped. Do not rewrite or reformat unrelated files.
- Never commit secrets, populated config files, databases, uploads, or build artifacts.
- Any frontend file that contains JSX must use the `.tsx` extension.
- All user-visible frontend strings must come from `@mangostudio/shared/i18n`.
- Public API shape changes must update the API code, shared contract, frontend consumer, and relevant tests in the same task.
- Shared contracts are schema-first: the TypeBox schema in `apps/shared/src/<module>/schemas.ts` is the single source of truth, and public types are derived with `Static<>`. Never hand-write a duplicate interface for a shape that already has a schema. `apps/shared/src/contracts/index.ts` is a compatibility barrel only — import from the bounded-context entrypoint (e.g. `@mangostudio/shared/agents`) in new code.
- API error responses must use `ApiErrorResponse` from `@mangostudio/shared/errors` or `SSEErrorEvent` from `@mangostudio/shared/streaming`. `ProblemDetails` (RFC 9457) is a third wire shape, but not a third thing to build: it is rendered from an `ApiErrorResponse` by the negotiation boundary in `apps/api/src/plugins/error-negotiation.ts` when the caller asks for `application/problem+json`. Never construct or return one from a route.
- The Mango Protocol (`spec/`, `packages/protocol/`, `crates/mango-protocol/`, `docs/protocol/`, `scripts/protocol/`) is one wire contract on its own `protocol-v*` release line. Any change under those paths follows `packages/protocol/AGENTS.md` and runs `bun run protocol:check && bun run protocol:test` — the repository gate runs only its TypeScript half.
- One parsing point per host for *configuration* — the environment variables that select a mode,
  a token, or a path the host trusts — never scattered: hub configuration parsing lives only in
  `apps/api/src/lib/config.ts`; the TypeScript runtime host's, only in
  `apps/runtime/src/config.ts`; the Rust runtime host's, only in
  `crates/mangostudio-runtime/src/config.rs`. Each host owns its own single parser — a second host
  cannot route its configuration through another host's module.
  Machine probing is a separate, legitimate carve-out: a detector describing what is actually on
  this machine (`PATH`, `$HOME`, an already-collected environment snapshot) reads the process
  environment directly, at the site that needs it, because that value is never configuration —
  nothing selects or validates it ahead of time, and scattering the probing sites is the point (a
  `PATH` walk lives with the walk it bounds). In the Rust host this is
  `crates/mangostudio-runtime/src/health.rs`'s two `PATH` fallbacks,
  `crates/mangostudio-runtime/src/runtime_home.rs`'s `home_dir()` for slot resolution,
  `crates/mangostudio-runtime/src/probing/host.rs`'s environment snapshot for detection, and
  `crates/mangostudio-runtime/src/subprocess/unix_guardian.rs`'s `vars_os()` snapshot that copies
  inherited environment entries for exact child execution before fork (it does not select or parse
  host configuration). `crates/mangostudio-runtime/tests/config_boundary.rs` greps its own source
  tree for `env::var`/`var_os`/`vars`/`vars_os`/`home_dir` calls outside `config.rs` and pins each one's exact call text
  (literal argument included) and occurrence count — not just which file it is in, since a file
  already on the list can otherwise grow a fourth call, or swap an allowed call's literal for a
  different one, without the test noticing. A change that adds a fifth site, or a third read in
  an already-listed file, fails the test, not a review comment.
- Shared code must remain framework-agnostic. Shared code that reaches a Node builtin gets its
  own export subpath (`@mangostudio/shared/library/host`, `/process/host`) so the browser bundle
  never resolves it.
- `apps/api` must not import `@mangostudio/runtime`. The only exception is
  `apps/api/src/services/runtime-client/connect-in-process-runtime.ts`, and a test enforces it;
  everything the two ends share is a contract in `@mangostudio/shared`. No production file may
  import that seam either: Local is the cargo-built `mangostudio-runtime` the hub spawns, so
  API tests that reach Local need it built (`cargo build -p mangostudio-runtime`) or named by
  `MANGOSTUDIO_RUNTIME_BINARY`.
- Cross-workspace imports must use package names, never relative paths.
- Do not edit `apps/frontend/src/routeTree.gen.ts`; it is generated.

## Rust workspace policy

- `Cargo.toml` and the root `Cargo.lock` own every stable Rust crate in this repository. Add new
  crates as workspace members instead of creating another lockfile or toolchain root.
- `crates/mango-protocol/fuzz` is the sole exception. It is an excluded nightly-only workspace
  with its own lockfile.
- `rust-toolchain.toml` pins the development toolchain. The protocol inherits the workspace MSRV;
  the published `mangostudio` launcher declares its lower MSRV explicitly. The launcher keeps the
  application version, while `[workspace.package].version` remains the protocol version.
- Check Rust changes with `cargo fmt --all -- --check`,
  `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`,
  `cargo test --workspace --all-targets --all-features --locked`,
  `cargo test --doc --workspace --all-features --locked` (`--all-targets` above excludes
  doctests by definition), and
  `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features --locked`. Protocol changes still
  run the separate protocol gates listed in `packages/protocol/AGENTS.md`.

## Naming Shortcuts

- Migration files: `NNN_description.ts`
- i18n keys: dot-separated by feature scope
- DB tables: `snake_case`; DB columns: `camelCase`
- Kysely aliases: `<Entity>Select`, `<Entity>Insert`, `<Entity>Update`

## Classification Labels

Every PR needs at least one `area:` or `type:` label — the "Verify classification labels" gate enforces it. Every issue needs exactly one `type:` label and a `status:` label.

`docs/reference/labels.md` has the full taxonomy and the glob-to-label map; `.github/labeler.yml` is what the gate actually reads.

## Validation

After **every** change, run `bun run check`. If it fails, run `bun run fix` and re-check.
Before final handoff, run `bun run check && bun run test` to validate all workspaces.
