# External API (API keys)

MangoStudio exposes the same HTTP API to browser sessions and to automation
clients. External callers authenticate with scoped API keys instead of cookies.

## Enabling access

1. Sign in to the app and open **Settings → External API**.
2. Turn on **Enable external API access** (`externalApiSettings.enabled` in app
   settings). When disabled, every key for that user is refused with
   `EXTERNAL_API_DISABLED` (403).
3. Create a key: choose a name, scope, and optional expiry. The plaintext key
   is shown once in the UI — copy it immediately; it is not stored in the query
   cache and cannot be retrieved later.

Key management (create, list, revoke) requires a cookie session. API keys cannot
manage other API keys.

## Authentication

Send the key on every request:

```http
x-api-key: mango_…
```

Better Auth resolves the key through the same session path as the browser, so
protected routes still use `requireAuth` without a separate auth stack. Keys
never work on `/api/auth/**`.

### Scopes

| Scope       | Allowed methods              |
| ----------- | ---------------------------- |
| `read-only` | `GET`, `HEAD`, `OPTIONS`     |
| `full`      | All methods on allowed paths |

Write or delete with a read-only key returns `API_KEY_SCOPE_FORBIDDEN` (403).

## Discovering endpoints

Interactive OpenAPI is served at `/scalar` on the API host (same origin as
`/api`). Use it to browse routes, schemas, and try requests when you have a
session cookie.

For contract shapes, `@mangostudio/shared` TypeBox schemas remain the source of
truth; integration tests often assert responses with `Value.Check`.

## Errors

HTTP errors use `ApiErrorResponse` from `@mangostudio/shared/errors`:

```json
{ "error": "Human-readable message", "code": "OPTIONAL_CODE" }
```

Common codes for external API traffic:

| Code                      | Typical status | Meaning                                  |
| ------------------------- | -------------- | ---------------------------------------- |
| `EXTERNAL_API_DISABLED`   | 403            | User toggle is off                       |
| `API_KEY_SCOPE_FORBIDDEN` | 403            | Method not allowed for key scope         |
| `RATE_LIMITED`            | 429            | Bucket limit exceeded; see `Retry-After` |

Rate limiting uses separate buckets for health, auth, browser (`general`), and
key-authenticated traffic (`api-key`). Counters are still per IP within each
bucket today, so a burst with `x-api-key` does not consume the general counter
for cookie traffic on the same host (per-key bucketing is tracked in #737).

## Security notes

- The API binds `0.0.0.0` by default. For non-localhost use, terminate TLS at a
  reverse proxy and set `TRUST_PROXY=true` only when the proxy overwrites
  client IP headers (see `docs/operations/deployment.md`).
- API keys are stored hashed server-side; only the prefix hint is kept for list
  views. Treat plaintext keys like passwords.
- Do not commit keys to git or paste them into public logs.

## Examples

Replace `BASE` and `KEY` with your API origin and key.

### curl

```bash
export MANGO_API_KEY='mango_your_key_here'
export BASE='http://localhost:3001'

curl -sS -H "x-api-key: $MANGO_API_KEY" "$BASE/api/health"
curl -sS -H "x-api-key: $MANGO_API_KEY" "$BASE/api/chats"
```

### Bun

```typescript
const base = process.env.BASE ?? 'http://localhost:3001';
const key = process.env.MANGO_API_KEY;
if (!key) throw new Error('Set MANGO_API_KEY');

const res = await fetch(`${base}/api/chats`, {
  headers: { 'x-api-key': key },
});
console.log(res.status, await res.json());
```

### Smoke script

From the repo root, with a running dev server and a valid key:

```bash
MANGO_API_KEY='mango_…' bun run scripts/examples/external-api-smoke.ts http://localhost:3001
```
