# Política De Segurança

## Reportando Uma Vulnerabilidade

Se você descobrir uma vulnerabilidade de segurança no MangoStudio, reporte-a de forma privada em vez de abrir uma issue pública.

**Email:** Crie um private security advisory pela aba Security do GitHub ou envie email diretamente aos mantenedores.

**SLA de resposta:** buscamos reconhecer o reporte em até 48 horas e fornecer um cronograma de correção em até 5 dias úteis.

## Versões Suportadas

Apenas o commit mais recente da branch `main` recebe correções de segurança. Não mantemos branches de backport para versões antigas.

## Modelo De Segurança

### Autenticação

- **Better Auth** com estratégia de email e senha.
- Autenticação baseada em sessão com cookies HTTP-only.
- Sessões são validadas em toda request protegida da API por `requireAuth`.
- Senhas dos usuários usam o hash scrypt padrão do Better Auth. A versão 1.7.10 fixada no lockfile delega ao `@better-auth/utils` 0.5.0; `apps/api/src/auth.ts` não configura overrides de hash ou verificação de senha.

### Armazenamento De Chaves De API

Cada conector persiste o backend de secrets selecionado no metadado `source`. A resolução lê esse backend; não há uma prioridade global ambiente → TOML → armazenamento do SO.

- **`environment`** — Lê primeiro a variável específica do conector (por exemplo, `OPENAI_API_KEY_WORK` para um conector chamado `work`) e depois a variável genérica do provedor (`OPENAI_API_KEY`). A UI grava no arquivo `.env` ao lado do arquivo de configuração selecionado (por padrão, `~/.mango/.env`). Esse fallback de nome de variável se aplica apenas a este backend.
- **`config-file`** — Lê a entrada com o nome do conector na seção do provedor no `config.toml` selecionado (por padrão, `~/.mango/config.toml`).
- **`bun-secrets`** — Lê a chave do conector no armazenamento de secrets do SO via `Bun.secrets`, usando o provedor e o ID do conector.

Proteja `.env`, `config.toml` e o diretório de dados com permissões do sistema de arquivos; mantenha arquivos preenchidos fora do controle de versão. A disponibilidade do armazenamento do SO depende do host. Fontes: `apps/api/src/services/providers/core/secret-service.ts` e `apps/api/src/modules/connectors/infrastructure/secret-persistence.ts`.

As chaves nunca são expostas ao frontend. A API resolve os secrets server-side e nunca os inclui nas responses.

### Rate Limiting

O rate limiter em memória conta requests por (bucket, id do cliente). A função
`classify` (`rate-limit-policy.ts`) classifica cada path em um bucket — `health`,
`auth`, `general` e `api-key` (tráfego com `x-api-key`) têm contadores
independentes no mesmo IP. Requests bloqueados retornam `429` no formato
`ApiErrorResponse` (`code: RATE_LIMITED`) com header `Retry-After`. Protege
contra brute-force e abuso. Headers de proxy (`X-Forwarded-For`, etc.) só
definem o cliente quando `trustProxy` / `TRUST_PROXY` está habilitado
explicitamente e apenas atrás de um proxy confiável que sobrescreve esses
headers; caso contrário o limiter usa o IP do socket.

### Validação De Entrada

- Todos os bodies de request da API são validados via schemas TypeBox antes do processamento.
- Uploads de arquivos são validados por MIME type, magic bytes, tamanho e correção de UTF-8.
- Há proteção contra path traversal em todas as operações com arquivos.
- Base URLs de provedores passam por validação de URL para bloquear endereços privados ou loopback.

### Proteção De Dados

- O arquivo `database.sqlite` contém dados de usuário. Restrinja o acesso ao sistema de arquivos ao usuário do processo.
- Nenhum PII é logado. Senhas, tokens e payloads brutos de autenticação são excluídos de todos os logs.
- Mensagens de erro retornadas ao cliente não contêm dados sensíveis, stack traces ou paths internos.

### Segurança Do Build

- `bun build --compile` empacota o hub como executável standalone; compilação não é uma fronteira de confidencialidade. JavaScript empacotado e corpos de funções podem continuar inspecionáveis. Não embuta secrets nem dependa do empacotamento para manter o código privado. As flags de distribuição em `scripts/lib/build.ts` incluem bytecode, ESM e source maps externos, além de minificação em produção.
- Assets do frontend são minificados e tree-shaken.
- Variáveis de ambiente não são embutidas no binário.

## O Que NÃO Reportar

- Ausência de assinaturas GPG em commits, pois isso é uma guideline de contribuição, não uma fronteira de segurança.
- Arquivos `.env` sem valores no repositório, porque são ignorados por `.gitignore` por padrão.
- Sugestões de configuração de rate limiting, pois são preocupações de configuração, não vulnerabilidades.
- Ataques teóricos que exigem acesso ao sistema de arquivos do servidor, porque, se o atacante já tem esse nível de acesso, o modelo de segurança já foi comprometido.
