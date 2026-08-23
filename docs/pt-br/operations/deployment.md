# Deploy

O MangoStudio pode ser implantado como binários standalone específicos por plataforma com assets do frontend embutidos.

## Docker

Imagens de release são publicadas no GitHub Container Registry. A imagem padrão
usa Debian Bookworm; imagens Alpine usam o sufixo `-alpine`:

```bash
docker run -p 3001:3001 \
  -v mango-data:/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e GEMINI_API_KEY="sua-chave" \
  ghcr.io/juliopolycarpo/mangostudio:0.1.0
```

A imagem define `HOME=/data`, então os arquivos de runtime padrão ficam no volume
montado (`/data/.mango/…`). Após o primeiro push no GHCR, pode ser necessário
alterar a visibilidade do pacote para **public** nas configurações do GitHub.

## Deploy manual de binário

Para instalação bare-metal sem gerenciador de pacotes, baixe o arquivo de
plataforma e `SHA256SUMS` do
[GitHub Releases](https://github.com/juliopolycarpo/mangostudio/releases/latest)
e verifique antes de extrair:

```bash
VERSION=0.1.0
PLATFORM=linux-x64
curl -LO "https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/SHA256SUMS"
curl -LO "https://github.com/juliopolycarpo/mangostudio/releases/download/v${VERSION}/mangostudio-${VERSION}-${PLATFORM}.tar.gz"

grep "mangostudio-${VERSION}-${PLATFORM}.tar.gz" SHA256SUMS | sha256sum -c -
tar -xzf "mangostudio-${VERSION}-${PLATFORM}.tar.gz" -C /opt/mangostudio
```

Arquivos Windows usam `.zip` (`windows-x64`, `windows-arm64`). Nomes e layout
estão documentados em
[`docs/reference/releasing.md`](../../reference/releasing.md#release-asset-naming).

## Build De Produção

```bash
bun run build --binary
```

Isso compila a API em binários sob `.mango/out/<platform>/` com o frontend embarcado no executável.

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
  ├── mangostudio       # Binário compilado (frontend embarcado)
  ├── run.sh            # Script auxiliar de inicialização
  └── README.md         # Notas da plataforma
```

O binário serve a SPA do frontend embarcada. Rotas da API são servidas sob `/api/`, e rotas SPA fazem fallback para `index.html`.

## Configuração

A configuração de produção usa `~/.mango/config.toml` e `~/.mango/.env` para o usuário do processo:

```toml
[server]
host = "0.0.0.0"
port = 3001
# Como pares fora deste processo alcançam o hub, o que é uma pergunta diferente
# de como ele faz o bind. Obrigatório para runtimes WebSocket pareados: o cartão
# de pareamento não tem outra forma de imprimir o endereço que eles discam, e um
# cabeçalho de requisição seria um palpite falsificável. Env: PUBLIC_URL.
publicUrl = "https://seu-dominio.com"
# Apenas para deploy dividido, em que o bundle do frontend é servido a partir de
# uma origem diferente desta API. É somado às origens do próprio servidor, nunca
# as substitui. Cada entrada precisa ser um scheme://host[:port] puro — caminho,
# barra final ou porta padrão explícita falham na inicialização, porque cada
# gate compara o cabeçalho Origin do navegador por string exata. Env:
# ALLOWED_ORIGINS (separado por vírgulas), que substitui esta lista.
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

**Obrigatório em produção:**

- Defina `auth.secret` como uma string aleatória forte com 32 ou mais caracteres.
- Defina `auth.url` com a URL pública da aplicação.
- Use um reverse proxy para terminação TLS.

### Deploy dividido

`allowedOrigins` é só metade de um deploy dividido. Ele diz a esta API de qual origem aceitar
requisições; o bundle também precisa saber onde a API está. Extraia
`mangostudio-<versão>-frontend-dist.tar.gz` e edite o `config.js` ao lado do `index.html`:

```js
window.__MANGO_CONFIG__ = { apiUrl: 'https://api.example.com' };
```

Não é preciso rebuildar — o arquivo é lido no carregamento da página e tem precedência sobre
qualquer valor embutido em tempo de build. Deixe `apiUrl` vazio (o padrão distribuído) para
usar a origem que serviu a página, que é o que tanto uma instalação de origem única quanto o
binário standalone querem. `MANGO_API_URL` define o mesmo valor em tempo de build, para quem
compila o bundle por conta própria. Veja `docs/architecture/frontend-build.md`.

## Banco De Dados

O banco SQLite usa `~/.mango/database.sqlite` por padrão. Em produção, configure um path persistente:

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

### Confiar nos headers de proxy

Atrás de um reverse proxy (incluindo Docker atrás de nginx/Caddy/load balancer),
o peer do socket é o proxy, não o cliente, então por padrão todos os chamadores
caem em um único contador de rate limit. Defina `TRUST_PROXY=true` (env) ou
`trustProxy = true` em `[security]` no `config.toml` para que o limiter resolva o
IP real do cliente a partir dos headers `X-Forwarded-For` / `X-Real-IP` /
`CF-Connecting-IP` que o proxy define.

> **Só habilite isso atrás de um proxy que sobrescreve esses headers** (a config
> nginx acima usa `$proxy_add_x_forwarded_for`). Com exposição direta à internet,
> um header confiável permite que qualquer cliente forje seu IP e burle o rate
> limiting.

## Serviço systemd

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

Valide o binário antes do deploy:

```bash
PLATFORM=linux-x64 bun run scripts/test-build.ts
```

Isso verifica:

- se o binário existe e é executável
- se os assets do frontend estão presentes, como `index.html`, JS e CSS
- se o endpoint de health responde com `GET /health`
- se o fallback da SPA serve `index.html` para rotas não API
- se as rotas da API não estão sendo interceptadas pelo fallback da SPA
- se as rotas de auth retornam as respostas esperadas
