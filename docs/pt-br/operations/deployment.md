# Deploy

O MangoStudio pode ser implantado como binários standalone específicos por plataforma com assets do frontend embutidos.

## Build De Produção

```bash
bun run build --binary
```

Isso compila a API em binários sob `.mango/out/<platform>/` com os assets do frontend como arquivos sidecar.

## Alvos De Plataforma

| Plataforma         | Arquitetura | Variante      |
| ------------------ | ----------- | ------------- |
| `linux-x64`        | x86_64      | glibc         |
| `linux-x64-musl`   | x86_64      | musl (Alpine) |
| `linux-arm64`      | ARM64       | glibc         |
| `linux-arm64-musl` | ARM64       | musl (Alpine) |
| `windows-x64`      | x86_64      | —             |
| `windows-arm64`    | ARM64       | —             |
| `darwin-x64`       | x86_64      | —             |
| `darwin-arm64`     | ARM64       | —             |

## Layout Do Binário

```
.mango/out/linux-x64/
  ├── mangostudio       # Binário compilado estaticamente
  ├── public/           # Assets SPA do frontend (index.html, JS, CSS)
  ├── run.sh            # Script auxiliar de inicialização
  └── README.md         # Notas da plataforma
```

O binário serve a SPA do frontend a partir do diretório `public/` ao lado do executável. Rotas da API são servidas sob `/api/`, e rotas SPA fazem fallback para `index.html`.

## Configuração

A configuração de produção usa os mesmos arquivos `.mango/config.toml` ou `.mango/.env`:

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

**Obrigatório em produção:**

- Defina `auth.secret` como uma string aleatória forte com 32 ou mais caracteres.
- Defina `auth.url` com a URL pública da aplicação.
- Use um reverse proxy para terminação TLS.

## Banco De Dados

O banco SQLite usa `~/.mangostudio/database.sqlite` por padrão. Em produção, configure um path persistente:

```toml
[database]
path = "/var/lib/mangostudio/database.sqlite"
```

SQLite com WAL mode é adequado para deploys single-server. O arquivo de banco deve ser incluído em rotinas de backup regulares.

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

        # Necessário para streaming SSE
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

## Serviço systemd

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

Valide o binário antes do deploy:

```bash
PLATFORM=linux-x64 bun run test-build
```

Isso verifica:

- se o binário existe e é executável
- se os assets do frontend estão presentes, como `index.html`, JS e CSS
- se o endpoint de health responde com `GET /health`
- se o fallback da SPA serve `index.html` para rotas não API
- se as rotas da API não estão sendo interceptadas pelo fallback da SPA
- se as rotas de auth retornam as respostas esperadas
