# Deployment

MangoStudio can be deployed as standalone platform-specific binaries with embedded frontend assets.

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
  ├── mangostudio       # Statically compiled binary
  ├── public/            # Frontend SPA assets (index.html, JS, CSS)
  ├── run.sh             # Startup helper script
  └── README.md          # Platform notes
```

The binary serves the frontend SPA from the `public/` directory next to the executable. API routes are served under `/api/` and SPA routes fallback to `index.html`.

## Configuration

Production configuration uses the same `.mango/config.toml` or `.mango/.env` files:

```toml
[server]
host = "0.0.0.0"
port = 3001

[database]
path = "/var/lib/mangostudio/database.sqlite"

[uploads]
dir = "/var/lib/mangostudio/uploads"

[images]
dir = "/var/lib/mangostudio/images"

[auth]
secret = "your-64-char-random-secret"
url = "https://your-domain.com"
```

**Required for production:**

- Set `auth.secret` to a strong random string (32+ characters).
- Set `auth.url` to your public-facing URL.
- Use a reverse proxy for TLS termination.

## Database

The SQLite database defaults to `~/.mangostudio/database.sqlite`. For production, configure a persistent path:

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

## Systemd Service

```ini
[Unit]
Description=MangoStudio
After=network.target

[Service]
Type=simple
User=mangostudio
WorkingDirectory=/opt/mangostudio
ExecStart=/opt/mangostudio/mangostudio
Restart=on-failure
RestartSec=5
Environment="MANGO_CONFIG_PATH=/etc/mangostudio/config.toml"

[Install]
WantedBy=multi-user.target
```

## Smoke Testing

Validate the binary before deployment:

```bash
PLATFORM=linux-x64 bun run test-build
```

This verifies:

- Binary exists and is executable.
- Frontend assets are present (`index.html`, JS, CSS).
- Health endpoint responds (`GET /health`).
- SPA fallback serves `index.html` for non-API routes.
- API routes are not intercepted by SPA fallback.
- Auth routes return expected responses.
