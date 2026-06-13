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
- User passwords are hashed using bcrypt (configured via Better Auth).

### API Key Storage

API keys (Gemini, OpenAI, Anthropic, DeepSeek) support three persistence methods, in priority order:

1. **Environment variables** (`~/.mango/.env`) — Highest priority, never committed.
2. **config.toml** (`~/.mango/config.toml`) — Flat file, never committed.
3. **OS Secret Store** (`Bun.secrets`) — Native OS-level secure storage. Recommended for maximum security.

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

- `bun build --compile` produces standalone binaries without exposing source code.
- Frontend assets are minified and tree-shaken.
- Environment variables are not bundled into the binary.

### Automation Security Gates

Pull requests are checked by two GitHub security workflows before merge:

- **CodeQL** (`.github/workflows/codeql.yml`) runs on pull requests to `main`, pushes to `main`, a weekly schedule, and manual dispatch. It uses CodeQL advanced setup for JavaScript/TypeScript with explicit no-build extraction and the `security-extended` query suite. The workflow uploads SARIF with a stable language category so alerts are visible in the Security tab and in the PR `Code scanning results / CodeQL` check.
- **Dependency Review** (`.github/workflows/dependency-review.yml`) runs on pull requests to `main` and blocks newly introduced moderate-or-worse vulnerable dependencies from manifest or lockfile changes. License checks are intentionally disabled.

When GitHub posts an Advanced Security setup comment on a PR, use it as a pointer
to the Security tab, not as the review process itself. Maintainers should review
the CodeQL analysis job, the `Code scanning results / CodeQL` check, and the
Dependency Review check before merging security-sensitive changes.

## What NOT to Report

- Missing GPG signatures on commits (this is a contribution guideline, not a security boundary).
- Unpopulated `.env` files in the repository (these are `.gitignore`d by default).
- Rate limiting configuration suggestions (these are configuration concerns, not vulnerabilities).
- Theoretical attacks that require filesystem access to the server (if an attacker has filesystem access, the security model is already compromised).
