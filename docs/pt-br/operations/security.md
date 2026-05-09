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
- Senhas dos usuários são hashadas com bcrypt, configurado via Better Auth.

### Armazenamento De Chaves De API

Chaves de API para Gemini, OpenAI, Anthropic e DeepSeek suportam três métodos de persistência, em ordem de prioridade:

1. **Variáveis de ambiente** em `.mango/.env` — prioridade mais alta, nunca versionadas.
2. **config.toml** em `~/.mango/config.toml` — arquivo flat, nunca versionado.
3. **OS Secret Store** via `Bun.secrets` — armazenamento nativo seguro do sistema operacional, recomendado para máxima segurança.

As chaves nunca são expostas ao frontend. A API resolve os secrets server-side e nunca os inclui nas responses.

### Rate Limiting

O rate limiter em memória usa janela e número máximo de requests configuráveis por janela. Ele protege contra brute-force e abuso da API. Pode ser configurado para confiar em headers de proxy quando o app roda atrás de reverse proxy.

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

- `bun build --compile` produz binários standalone sem expor o código-fonte.
- Assets do frontend são minificados e tree-shaken.
- Variáveis de ambiente não são embutidas no binário.

## O Que NÃO Reportar

- Ausência de assinaturas GPG em commits, pois isso é uma guideline de contribuição, não uma fronteira de segurança.
- Arquivos `.env` sem valores no repositório, porque são ignorados por `.gitignore` por padrão.
- Sugestões de configuração de rate limiting, pois são preocupações de configuração, não vulnerabilidades.
- Ataques teóricos que exigem acesso ao sistema de arquivos do servidor, porque, se o atacante já tem esse nível de acesso, o modelo de segurança já foi comprometido.
