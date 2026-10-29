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
# Crie o destino antes de tar -C (sudo é necessário para /opt).
sudo install -d -m 0755 /opt/mangostudio
sudo tar -xzf "mangostudio-${VERSION}-${PLATFORM}.tar.gz" -C /opt/mangostudio
```

Arquivos Windows usam `.zip` (`windows-x64`, `windows-arm64`). Nomes e layout
estão documentados em
[`docs/reference/releasing.md`](../../reference/releasing.md#release-asset-naming).

## Build De Produção

```bash
bun run build:binary # build nativo para o SO, arquitetura e libc deste host
# Fallback explícito de compilação cruzada em bytecode, com os 8 runtimes Rust prontos:
bun run build:binary --compiler bytecode --runtime-dir .mango/runtime-prebuilt
```

O build nativo compila o hub com AOT do Bun, remoção de recursos não usados do runtime,
minificação em produção, ESM e source maps externos. Ele embarca o frontend em
`.mango/out/<platform>/mangostudio` e coloca o `mangostudio-runtime` construído com cargo ao
lado. Um `--platform` diferente do host falha antes do trabalho de frontend ou runtime,
mesmo com `--runtime-dir`.

`--runtime-dir <dir>` fornece `<dir>/<platform>/mangostudio-runtime[.exe]`; sem ele, cargo
constrói o runtime local. A compilação cruzada exige `--compiler bytecode` e um runtime
pré-construído para cada alvo solicitado. Sem `--platform`, o modo bytecode seleciona os
8 alvos. Veja [releasing.md](../reference/releasing.md#como-o-binário-do-runtime-é-construído).

Para um frontend preparado, `--reuse-frontend` exige `apps/frontend/dist/build-info.json`
do mesmo HEAD limpo e modo de build, com `gitDirty: false`. Ele preserva o horário original
do build e regenera os caminhos absolutos de embed no host atual.

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
  ├── mangostudio          # Hub compilado com Bun (frontend embarcado)
  ├── mangostudio-runtime  # Runtime construído com cargo; iniciado como Local
  ├── run.sh               # Script auxiliar de inicialização
  └── README.md            # Notas da plataforma
```

O binário serve a SPA do frontend embarcada. Rotas da API são servidas sob `/api/`, e rotas SPA fazem fallback para `index.html`.

Os dois binários são uma unidade: o hub inicia o `mangostudio-runtime` ao lado do próprio
executável, e o handshake do protocolo recusa um runtime de outra versão. Mantenha os dois
juntos ao copiar um build e atualize ambos de uma vez.

## Requisitos Do Binário Do Runtime

O runtime é um binário Rust nativo, sem interpretador nem runtime compartilhado para instalar:

- **Linux glibc** (`linux-x64`, `linux-arm64`): glibc 2.17 ou mais novo, o mesmo piso do hub.
- **Linux musl** (`*-musl`): o runtime é linkado estaticamente e não precisa de pacotes extras. O
  hub é um binário compilado pelo Bun que linka `libstdc++` dinamicamente, então um Alpine puro
  precisa de `apk add libstdc++` antes de executar o hub do arquivo `*-musl` correspondente.
  Use a [extração manual](#deploy-manual-de-binário); a estável mais recente `v0.1.1`
  não tem assets de scripts instaladores (verificado em 2026-10-22).
- **Windows**: o runtime C do MSVC é linkado estaticamente, então o Visual C++ Redistributable
  não é necessário.
- **macOS**: um binário por arquitetura (`darwin-x64`, `darwin-arm64`).

`mangostudio-runtime --version` imprime só a versão da release; `mangostudio doctor` e o
provisionamento WSL/SSH a comparam com a do hub. Todo asset da release, inclusive os binários
crus do runtime, está no `SHA256SUMS`, e o `SHA256SUMS` tem uma attestation de proveniência de
build:

```bash
gh attestation verify SHA256SUMS --repo juliopolycarpo/mangostudio
```

Veja [releasing.md](../reference/releasing.md#como-o-binário-do-runtime-é-construído) para
como cada alvo é construído e verificado.

## Configuração

### Aviso de atualização do bind padrão

**Mudança de padrão incompatível:** um hub sem host configurado agora escuta em
`localhost`, em foreground e detached. Instalações que dependiam de acesso LAN
implícito devem optar por `mangostudio serve 0.0.0.0` (ou `serve lan`),
`API_HOST=0.0.0.0` ou `[server] host = "0.0.0.0"` no config.toml. O host da CLI
prevalece sobre `API_HOST`; o ambiente do processo prevalece sobre o `.env` ao
lado do config.toml, depois TOML e depois o padrão. Hosts explícitos mantêm seu
comportamento.

As duas variantes Docker definem `MANGOSTUDIO_DEFAULT_API_HOST=0.0.0.0` para
manter portas publicadas acessíveis por padrão. Esse padrão exclusivo do processo
fica abaixo do host explícito da CLI, de `API_HOST` (processo ou `.env` adjacente)
e do host de um TOML montado.
Autenticação, terminação TLS e origens permitidas do navegador continuam exigindo
sua configuração normal. O exemplo em todas as interfaces abaixo é uma opção
explícita de acesso remoto.

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

    # Comprime o bundle do frontend e JSON. text/html entra sempre que o gzip
    # está ligado; text/event-stream fica de fora, então o SSE não é comprimido.
    gzip on;
    gzip_vary on;
    gzip_types text/css text/javascript application/javascript application/json image/svg+xml;

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
    # Comprime o bundle do frontend e JSON. A lista é explícita porque a padrão
    # casa text/*, o que também comprime SSE (text/event-stream) quando um
    # evento passa de 512 bytes.
    encode zstd gzip {
        match {
            header Content-Type text/html*
            header Content-Type text/css*
            header Content-Type text/javascript*
            header Content-Type application/javascript*
            header Content-Type application/json*
            header Content-Type image/svg+xml*
        }
    }
    reverse_proxy 127.0.0.1:3001
}
```

### Compressão

O hub serve o bundle do frontend sem compressão e deixa a compressão para o proxy. Os dois
exemplos acima comprimem: o arquivo JavaScript principal cai de cerca de 1,8 MB para cerca de
0,6 MB na rede, o que importa no acesso remoto (um navegador na mesma máquina ganha pouco).
Fontes e imagens já são comprimidas e não entram na lista.

Respostas SSE (`text/event-stream`) ficam sem compressão de propósito, para que cada evento
chegue ao navegador assim que o hub o envia. Se você ampliar alguma das listas, mantenha
`text/event-stream` fora dela e mantenha `proxy_buffering off` no nginx.

Se outro proxy, load balancer ou CDN ficar na frente do nginx e adicionar o header de requisição
`Via`, o nginx trata a requisição como proxied e, por padrão, não aplica gzip. Nesse cenário,
adicione `gzip_proxied any;` ao lado de `gzip on;`.

Para conferir um deploy, peça um asset com hash da página com `GET` e leia os headers
(`curl -I` envia `HEAD`, que as rotas de assets do hub não respondem):

```bash
curl -sS -o /dev/null -D - -H 'Accept-Encoding: gzip' \
  https://your-domain.com/assets/main-<hash>.js | grep -i '^content-encoding:'
```

Uma resposta comprimida imprime o header `Content-Encoding: gzip` (a caixa varia conforme o
proxy). Nenhuma saída (e o `grep` saindo com 1) significa que o proxy enviou o arquivo sem
compressão. Para conferir o caminho zstd do Caddy, envie `Accept-Encoding: zstd` e espere `zstd`.

### Confiar nos headers de proxy

Atrás de um reverse proxy (incluindo Docker atrás de nginx/Caddy/load balancer),
o peer do socket é o proxy, não o cliente, então por padrão todos os chamadores
caem em um único contador de rate limit. Defina `TRUST_PROXY=true` (env) ou
`trustProxy = true` em `[security]` no `config.toml` para que o limiter resolva o
IP real do cliente a partir dos headers `X-Forwarded-For` / `X-Real-IP` /
`CF-Connecting-IP` que o proxy define.

A mesma configuração decide o guard de superfície local que protege as
instalações de ambiente e as ações de máquina (`/api/machine/restart`,
`/api/machine/service`, `/api/machine/logs`). Esse guard pergunta se o browser
está no teclado desta máquina, e o peer do socket não responde isso atrás de um
proxy — todo chamador chega de loopback. Com `TRUST_PROXY=true` quem responde é o
cliente encaminhado, então uma sessão remota autenticada é corretamente recusada.

Os dois leem hops diferentes do `X-Forwarded-For`, porque as perguntas são
diferentes. O header é uma lista, e um proxy _acrescenta_ o endereço que viu em
vez de substituir a lista — tanto o `$proxy_add_x_forwarded_for` acima quanto o
`reverse_proxy` do Caddy fazem isso. O limiter usa o **primeiro** hop, o cliente
de origem, que é a chave certa para um contador. O guard usa o **último**, o que
o seu proxy escreveu, porque toda entrada anterior é o que o chamador mandou —
um browser remoto pode pôr `X-Forwarded-For: 127.0.0.1` numa requisição de mesma
origem, e o guard não pode ler isso como o seu teclado.

> **Só habilite isso atrás de um proxy que de fato define esses headers.** Com
> exposição direta à internet, ou atrás de algo que repassa o `X-Forwarded-For`
> do chamador sem acrescentar nada, um header confiável permite que qualquer
> cliente forje seu IP — burlando o rate limiting e passando pelo guard de
> superfície local.

#### Quando o proxy não define header encaminhado

Um proxy que repassa sem `X-Forwarded-For` — um bloco `location` do nginx sem
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` — deixa o guard
apenas com o peer do socket para ler, e esse peer é o próprio proxy, em loopback.
Aí todo browser remoto passa por uma verificação que significa "no teclado desta
máquina".

`ALLOW_DIRECT_LOOPBACK` (env) ou `allowDirectLoopback` em `[security]` decide o
que acontece nesse caso. O padrão é `true`: uma requisição sem encaminhamento é
julgada pelo peer do socket, exatamente como antes de `TRUST_PROXY` ser ligado,
então um browser que fala direto com o hub — passando por cima do proxy em
`localhost:3001` — mantém a página da máquina e suas instalações.

```toml
[security]
trustProxy = true
allowDirectLoopback = false
```

Defina `false` quando o proxy à frente deste hub não define `X-Forwarded-For` e
você não pode mudar isso. Uma requisição sem encaminhamento passa a ser recusada
como `client-unverified` em vez de aceita como local — um motivo distinto de
`client-not-loopback`, então a página diz que o endereço não pôde ser
estabelecido em vez de afirmar que o chamador está em outro lugar. Requisições
diretas à porta do hub são recusadas junto, e a CLI (`mangostudio restart`,
`mangostudio service install`) continua sendo o caminho.

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

O rebuild exige SO, arquitetura e libc correspondentes ao host. Para um alvo
pré-construído com manifesto, `SKIP_BUILD=1` também exige `SOURCE_SHA` e
`DISTRIBUTION_CHANNEL`. Alvos de outra plataforma recebem verificações de layout
e checksum; verificações de comportamento só executam quando o host suporta o alvo.

Para alvos executáveis, isso verifica:

- se o binário existe e é executável
- se os assets do frontend estão presentes, como `index.html`, JS e CSS
- se o endpoint de health responde com `GET /health`
- se o fallback da SPA serve `index.html` para rotas não API
- se as rotas da API não estão sendo interceptadas pelo fallback da SPA
- se as rotas de auth retornam as respostas esperadas
