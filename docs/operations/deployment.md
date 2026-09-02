# Deployment

MangoStudio can be deployed as standalone platform-specific binaries with embedded frontend assets.

## Docker

Release images are published to GitHub Container Registry. The default image is
Debian Bookworm; Alpine images use the `-alpine` version suffix:

```bash
docker run -p 3001:3001 \
  -v mango-data:/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e GEMINI_API_KEY="your-key" \
  ghcr.io/juliopolycarpo/mangostudio:0.1.0
```

The image sets `HOME=/data`, so the default runtime files live under the mounted
volume:

- `/data/.mango/config.toml`
- `/data/.mango/.env`
- `/data/.mango/database.sqlite`
- `/data/.mango/uploads`
- `/data/.mango/images`
- `/data/.mango/tool-images`
- `/data/.mango/agents`

Useful environment variables:

| Variable             | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | Required 32+ character auth secret                                            |
| `GEMINI_API_KEY`     | Gemini connector key; other provider keys use the same env                    |
| `API_PORT`           | Container listen port, default `3001`                                         |
| `DATABASE_PATH`      | Override SQLite path, default `/data/.mango/database.sqlite`                  |
| `UPLOADS_DIR`        | Override uploaded file storage path                                           |
| `IMAGES_DIR`         | Override generated image storage path                                         |
| `TOOL_IMAGES_DIR`    | Override custom tool avatar storage path                                      |
| `AGENTS_DIR`         | Override agent settings storage path                                          |
| `BETTER_AUTH_URL`    | Public URL when deployed behind a domain                                      |
| `TRUST_PROXY`        | Set to `true` only behind a header-overwriting proxy                          |
| `ALLOWED_ORIGINS`    | Comma-separated browser origins allowed when the frontend is served elsewhere |

`ALLOWED_ORIGINS` is only half of a split deployment. It tells this API which origin to accept
requests from; the bundle also has to be told where the API is. Unpack
`mangostudio-<version>-frontend-dist.tar.gz` and edit `config.js` beside `index.html`:

```js
window.__MANGO_CONFIG__ = { apiUrl: 'https://api.example.com' };
```

No rebuild is needed — the file is read at page load, and it outranks anything baked in at
build time. Leave `apiUrl` empty (the shipped default) to use the origin the page was served
from, which is what a single-origin install and the standalone binary both want.
`MANGO_API_URL` sets the same value at build time, for anyone building the bundle themselves.
See `docs/architecture/frontend-build.md`.

Compose example:

```yaml
services:
  mangostudio:
    image: ghcr.io/juliopolycarpo/mangostudio:0.1.0
    ports:
      - "3001:3001"
    volumes:
      - mango-data:/data
    environment:
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      API_PORT: "3001"
      DATABASE_PATH: /data/.mango/database.sqlite

volumes:
  mango-data:
```

The first GHCR package may need its visibility changed to public in the GitHub
package settings after the first release push.

## Manual binary deploy

For bare-metal installs without a package manager, download the platform archive
and `SHA256SUMS` from [GitHub Releases](https://github.com/juliopolycarpo/mangostudio/releases/latest),
then verify before extracting:

```bash
VERSION=0.1.0
PLATFORM=linux-x64
curl -LO "https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/SHA256SUMS"
curl -LO "https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/mangostudio-${VERSION}-${PLATFORM}.tar.gz"

# Linux — verify checksum
grep "mangostudio-${VERSION}-${PLATFORM}.tar.gz" SHA256SUMS | sha256sum -c -

# macOS — verify checksum
grep "mangostudio-${VERSION}-darwin-arm64.tar.gz" SHA256SUMS | shasum -a 256 -c -

# Or use the project helper (from a clone)
bun ./scripts/release/verify-checksum.ts SHA256SUMS "mangostudio-${VERSION}-${PLATFORM}.tar.gz"

tar -xzf "mangostudio-${VERSION}-${PLATFORM}.tar.gz" -C /opt/mangostudio
```

Windows archives use `.zip` instead of `.tar.gz` (`windows-x64`, `windows-arm64`).
Asset names and archive layout are documented in
[`docs/reference/releasing.md`](../reference/releasing.md#release-asset-naming).

Windows-only environment variable:

| Variable        | Purpose                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANGO_WSL_EXE` | Overrides which `wsl.exe` the hub spawns for WSL environments. Auto-detected otherwise (`%ProgramFiles%\WSL\wsl.exe`, then `%ProgramW6432%\WSL\wsl.exe` for a 32-bit host process, then `%SystemRoot%\System32\wsl.exe`, then PATH); `mango doctor --env` reports the resolved path and its source. |

## Production Build

```bash
bun run build --binary
```

This compiles the API into binaries under `.mango/out/<platform>/` with the frontend assets as sidecar files.

## Platform Targets

| Platform           | Arch   | Variant       |
| ------------------ | ------ | ------------- |
| `linux-x64`        | x86_64 | glibc         |
| `linux-x64-musl`   | x86_64 | musl (Alpine) |
| `linux-arm64`      | ARM64  | glibc         |
| `linux-arm64-musl` | ARM64  | musl (Alpine) |
| `windows-x64`      | x86_64 | —             |
| `windows-arm64`    | ARM64  | —             |
| `darwin-x64`       | x86_64 | —             |
| `darwin-arm64`     | ARM64  | —             |

## Binary Layout

```
.mango/out/linux-x64/
  ├── mangostudio       # Statically compiled binary (frontend embedded)
  ├── run.sh             # Startup helper script
  └── README.md          # Platform notes
```

The binary serves the embedded frontend SPA. API routes are served under `/api/` and SPA routes fallback to `index.html`.

## Configuration

Production configuration uses `~/.mango/config.toml` and `~/.mango/.env` for the process user:

```toml
[server]
host = "0.0.0.0"
port = 3001
# How peers outside this process reach the hub, which is a different question
# from how it binds. Required for paired WebSocket runtimes: the pairing card
# has no other way to print the address they dial, and a request header would
# be a spoofable guess. Env override: PUBLIC_URL. Direct URL environments do
# not need this — the hub dials the runtime's baseUrl instead.
publicUrl = "https://your-domain.com"
# Only for a split deployment, where the frontend bundle is served from a
# different origin than this API. Added to the server's own origins, never
# substituted for them. Each entry must be a bare scheme://host[:port] — a path,
# a trailing slash, or an explicit default port fails at startup, because every
# gate compares the browser's Origin header by exact string. Env override:
# ALLOWED_ORIGINS (comma-separated), which replaces this list.
allowedOrigins = ["https://studio.example.com"]

[database]
path = "/var/lib/mangostudio/database.sqlite"

[uploads]
dir = "/var/lib/mangostudio/uploads"

[images]
dir = "/var/lib/mangostudio/images"

[agents]
dir = "/var/lib/mangostudio/agents"

[auth]
secret = "your-64-char-random-secret"
url = "https://your-domain.com"
```

**Required for production:**

- Set `auth.secret` to a strong random string (32+ characters).
- Set `auth.url` to your public-facing URL.
- Use a reverse proxy for TLS termination.

## Database

The SQLite database defaults to `~/.mango/database.sqlite`. For production, configure a persistent path:

```toml
[database]
path = "/var/lib/mangostudio/database.sqlite"
```

SQLite with WAL mode is suitable for single-server deployments. The database file should be backed up regularly.

## Reverse Proxy

### nginx

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for SSE streaming
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

### Caddy

```
your-domain.com {
    reverse_proxy 127.0.0.1:3001
}
```

### Trusting proxy headers

Behind a reverse proxy (including Docker behind nginx/Caddy/a load balancer) the
socket peer is the proxy, not the client, so by default every caller collapses
to one rate-limit counter. Set `TRUST_PROXY=true` (env) or `trustProxy = true`
under `[security]` in `config.toml` so the limiter resolves the real client IP
from the `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP` headers the proxy
sets.

The same setting decides the local-surface guard that gates environment installs
and the machine actions (`/api/machine/restart`, `/api/machine/service`,
`/api/machine/logs`). That guard asks whether the browser is at this machine's
keyboard, and the socket peer cannot answer it behind a proxy — every caller
arrives from loopback. With `TRUST_PROXY=true` the forwarded client answers
instead, so a remote signed-in session is correctly refused.

> **Only enable this behind a proxy that overwrites those headers** (the nginx
> config above uses `$proxy_add_x_forwarded_for`). With direct internet exposure,
> a trusted header lets any client spoof its IP and evade rate limiting.

## Systemd Service

```ini
[Unit]
Description=MangoStudio
After=network.target

[Service]
Type=simple
User=mangostudio
WorkingDirectory=/opt/mangostudio
ExecStart=/opt/mangostudio/mangostudio serve
Restart=on-failure
RestartSec=5
Environment="HOME=/var/lib/mangostudio"

[Install]
WantedBy=multi-user.target
```

## Smoke Testing

Validate the binary before deployment:

```bash
PLATFORM=linux-x64 bun run scripts/test-build.ts
```

This verifies:

- Binary exists and is executable.
- Frontend assets are present (`index.html`, JS, CSS).
- Health endpoint responds (`GET /health`).
- SPA fallback serves `index.html` for non-API routes.
- API routes are not intercepted by SPA fallback.
- Auth routes return expected responses.
