# Documentation

This directory is organized by responsibility so contributors can find the
right depth quickly instead of scanning a flat list of files.

## Structure

| Folder          | Audience                     | Purpose                                                           |
| --------------- | ---------------------------- | ----------------------------------------------------------------- |
| `architecture/` | Maintainers, feature authors | System design, cross-cutting runtime behavior, and internal flows |
| `features/`     | Feature authors              | Behavior and implementation notes for product areas               |
| `design/`       | Frontend and native authors  | The flat design system: tokens, components, patterns, decisions   |
| `protocol/`     | Protocol implementers, hosts | Mango Protocol adoption, conformance and independent releases     |
| `providers/`    | Provider integrators         | Provider-specific notes and provider onboarding guides            |
| `reference/`    | Contributors, agents         | API surface, testing rules, and file-map navigation               |
| `guides/`       | New contributors             | Task-oriented onboarding and contributor workflows                |
| `operations/`   | Deployers, operators         | Deployment and security guidance                                  |
| `pt-br/`        | Portuguese readers           | Partial Portuguese coverage; explicit English fallbacks           |

## Recommended Reading

### New contributor

1. [`../README.md`](../README.md)
2. [`guides/first-run.md`](./guides/first-run.md)
3. [`guides/contributor-quickstart.md`](./guides/contributor-quickstart.md)
4. [`reference/testing.md`](./reference/testing.md)
5. [`reference/agent-playbooks.md`](./reference/agent-playbooks.md) when you need a feature map
6. [`reference/labels.md`](./reference/labels.md) before opening a PR or issue

### Backend or architecture work

1. [`architecture/overview.md`](./architecture/overview.md)
2. [`architecture/streaming.md`](./architecture/streaming.md)
3. [`architecture/continuation.md`](./architecture/continuation.md)
4. [`providers/development.md`](./providers/development.md)

### Product feature work

- [`features/settings.md`](./features/settings.md)
- [`features/tools.md`](./features/tools.md)
- [`features/attachments.md`](./features/attachments.md)
- [`features/image-generation.md`](./features/image-generation.md)
- [`features/terminal.md`](./features/terminal.md)
- [`features/environments.md`](./features/environments.md)

### Frontend / UI work

1. [`design/README.md`](./design/README.md): principles, page index, and the tests that
   enforce the system
2. [`design/foundations.md`](./design/foundations.md): every token and its rule
3. [`design/components.md`](./design/components.md) and
   [`design/patterns.md`](./design/patterns.md) before building or changing a screen
4. [`design/decisions.md`](./design/decisions.md) before changing a rule
5. [`architecture/frontend-build.md`](./architecture/frontend-build.md) for the bundle and
   the test harness

### Provider-specific notes

- [`providers/chatgpt.md`](./providers/chatgpt.md)
- [`providers/cursor.md`](./providers/cursor.md)
- [`providers/deepseek.md`](./providers/deepseek.md)

### Ops and deployment

- [`reference/cli.md`](./reference/cli.md)
- [`reference/ci.md`](./reference/ci.md)
- [`reference/releasing.md`](./reference/releasing.md)
- [`reference/runtime-metrics.md`](./reference/runtime-metrics.md)
- [`operations/deployment.md`](./operations/deployment.md)
- [`operations/remote-runtimes.md`](./operations/remote-runtimes.md)
- [`SECURITY.md`](../.github/SECURITY.md)

## Notes

- Root-level docs should stay limited to top-level entry points such as `README.md`, `.github/CONTRIBUTING.md`, and `AGENTS.md`.
- `docs/pt-br/` follows the same folders where translations exist. Update existing English and Portuguese counterparts together. The fallback table below covers pages available only in English.

## Portuguese coverage and English fallbacks

On 2026-11-06, 37 of the 59 tracked Markdown, MDX, and MDC pages outside
`pt-br/` had a Portuguese counterpart at the same path. The
[Portuguese entry point](./pt-br/README.md#documentação) links to this table of the
22 pages available only in English.

| English page (no Portuguese counterpart)                                                           | Topic                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------- |
| [`architecture/environment-installs.md`](./architecture/environment-installs.md)                   | Environment install lifecycle   |
| [`architecture/external-agents.md`](./architecture/external-agents.md)                             | External agent ownership        |
| [`architecture/frontend-build.md`](./architecture/frontend-build.md)                               | Frontend build and test harness |
| [`architecture/hub-runtime.md`](./architecture/hub-runtime.md)                                     | Hub/runtime boundary            |
| [`architecture/runtime-contract.md`](./architecture/runtime-contract.md)                           | Runtime contract                |
| [`architecture/runtime-dispatcher.md`](./architecture/runtime-dispatcher.md)                       | Runtime dispatcher              |
| [`architecture/typescript-runtime-retirement.md`](./architecture/typescript-runtime-retirement.md) | TypeScript runtime retirement   |
| [`operations/remote-runtimes.md`](./operations/remote-runtimes.md)                                 | Remote runtimes                 |
| [`protocol/README.md`](./protocol/README.md)                                                       | Protocol guide index            |
| [`protocol/adopt-rust.md`](./protocol/adopt-rust.md)                                               | Rust protocol adoption          |
| [`protocol/adopt-typescript.md`](./protocol/adopt-typescript.md)                                   | TypeScript protocol adoption    |
| [`protocol/build-a-contract.md`](./protocol/build-a-contract.md)                                   | Build a protocol contract       |
| [`protocol/conformance.md`](./protocol/conformance.md)                                             | Protocol conformance            |
| [`protocol/releasing.md`](./protocol/releasing.md)                                                 | Protocol releases               |
| [`protocol/versioning.md`](./protocol/versioning.md)                                               | Protocol versioning             |
| [`providers/cursor.md`](./providers/cursor.md)                                                     | Cursor provider                 |
| [`reference/bun-tooling.md`](./reference/bun-tooling.md)                                           | Bun tooling                     |
| [`reference/canary-validation.md`](./reference/canary-validation.md)                               | Canary source qualification     |
| [`reference/ci-gates.md`](./reference/ci-gates.md)                                                 | CI gates                        |
| [`reference/ci-optimization-evidence.md`](./reference/ci-optimization-evidence.md)                 | CI simplification evidence      |
| [`reference/mcp.md`](./reference/mcp.md)                                                           | MCP servers                     |
| [`reference/skills.md`](./reference/skills.md)                                                     | Skills                          |
