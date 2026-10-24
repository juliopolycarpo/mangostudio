# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in MangoStudio, please report it privately rather than opening a public issue.

**Email:** Create a private security advisory through GitHub's Security tab, or email the maintainers directly.

**Response SLA:** We aim to acknowledge reports within 48 hours and provide a fix timeline within 5 business days.

## Supported Versions

Only the latest commit on the `main` branch receives security fixes. We do not maintain backport branches for older versions.

## Security Model

### Authentication

- **Better Auth** with email/password strategy.
- Session-based authentication via HTTP-only cookies.
- Sessions are validated on every protected API request via `requireAuth` middleware.
- User passwords use Better Auth’s default scrypt hashing. The locked Better Auth 1.7.10 delegates to `@better-auth/utils` 0.5.0; `apps/api/src/auth.ts` configures no password hash/verify override.

### API Key Storage

Each connector persists its selected secret backend in its `source` metadata. Resolution reads that backend; there is no global environment → TOML → OS-store priority chain.

- **`environment`** — Reads the connector-specific variable first (for example, `OPENAI_API_KEY_WORK` for a connector named `work`), then the provider’s generic variable (`OPENAI_API_KEY`). UI writes go to the `.env` file beside the selected config file (by default `~/.mango/.env`). This variable-name fallback applies only within this backend.
- **`config-file`** — Reads the connector’s named entry in its provider section of the selected `config.toml` (by default `~/.mango/config.toml`).
- **`bun-secrets`** — Reads the connector’s key from the OS secret store through `Bun.secrets`, under its provider and connector ID.

Protect `.env`, `config.toml` and the data directory with filesystem permissions; keep populated files out of version control. OS-store availability depends on the host. Source: `apps/api/src/services/providers/core/secret-service.ts` and `apps/api/src/modules/connectors/infrastructure/secret-persistence.ts`.

Keys are never exposed to the frontend. The API resolves secrets server-side and never includes them in responses.

### Rate Limiting

In-memory rate limiter with configurable window and max requests per window. Protects against brute-force attacks and API abuse. Can be configured to trust proxy headers when deployed behind a reverse proxy.

### Input Validation

- All API request bodies are validated via TypeBox schemas before processing.
- File uploads are validated for MIME type, magic bytes, size, and UTF-8 correctness.
- Path traversal protection on all file operations (upload storage, generated image storage, attachment resolution).
- URL validation on provider base URLs (rejects private/loopback addresses).

### Data Protection

- The database file (`database.sqlite`) contains user data. Restrict filesystem access to the process user.
- No PII is logged. Passwords, tokens, and raw authentication payloads are excluded from all log output.
- Error messages returned to clients do not contain sensitive data, stack traces, or internal paths.

### Build Security

- `bun build --compile` packages the hub as a standalone executable; compilation is not a confidentiality boundary. Bundled JavaScript and function bodies may remain inspectable. Do not embed secrets or rely on packaging to keep source private. The shipping flags in `scripts/lib/build.ts` include bytecode, ESM and external source maps, plus minification for production.
- Frontend assets are minified and tree-shaken.
- Environment variables are not bundled into the binary.

### Automation Security Gates

Pull requests are checked by these GitHub security workflows before merge:

- **CodeQL** (`.github/workflows/codeql.yml`) runs on pull requests to `main`, pushes to `main`, a weekly schedule, and manual dispatch. It uses CodeQL advanced setup for JavaScript/TypeScript and Rust (on Linux and on Windows, so `cfg(windows)` code is scanned too) with explicit no-build extraction and the `security-extended` query suite. The workflow uploads SARIF with a stable per-language category so alerts are visible in the Security tab and in the PR `Code scanning results / CodeQL` check.
- **Dependency Review** (`.github/workflows/dependency-review.yml`) runs on pull requests to `main` and blocks newly introduced moderate-or-worse vulnerable dependencies from manifest or lockfile changes. License checks are intentionally disabled.
- **Dependency Audit** (`.github/workflows/dependency-audit.yml`) audits every package in `bun.lock` for moderate-or-worse advisories on a daily schedule and once through CI on every pull request, even when no dependencies change. Both CI aggregates (`Gate` and `CI Gate`) require success and reject failed, cancelled or skipped audits. Unlike Dependency Review, it also flags advisories published after a version was locked. Fork PRs use the ordinary `pull_request` CI event, read-only permissions and no secrets; the audit does not install dependencies. Cargo advisory auditing reuses `deny.toml` and `cargo deny check advisories`; Protocol CI retains the bans, licenses and sources policies without duplicating advisory checks.

The workflow enforces the audit within CI's aggregate results. Repository rules
currently require the shared `Gate` context, also emitted by other workflows.
Requiring the unique `CI Gate` context would remove that naming ambiguity; this
requires a separately approved ruleset change. Workflow edits do not change
branch protection, permissions or security settings.

When GitHub posts an Advanced Security setup comment on a PR, use it as a pointer
to the Security tab, not as the review process itself. Maintainers should review
the CodeQL analysis job, the `Code scanning results / CodeQL` check, and the
Dependency Review check before merging security-sensitive changes.

## What NOT to Report

- Missing GPG signatures on commits (this is a contribution guideline, not a security boundary).
- Unpopulated `.env` files in the repository (these are `.gitignore`d by default).
- Rate limiting configuration suggestions (these are configuration concerns, not vulnerabilities).
- Theoretical attacks that require filesystem access to the server (if an attacker has filesystem access, the security model is already compromised).
