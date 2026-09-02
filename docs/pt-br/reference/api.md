# Referência Da API

O MangoStudio expõe uma API REST em `/api/` e um endpoint de streaming SSE.

Os contratos de `@mangostudio/shared` são a fonte de verdade para tipos de request e response. Esta página é um mapa voltado a contribuidores da superfície atual, não uma referência OpenAPI gerada.

## Base URL

```
http://localhost:3001/api
```

## Autenticação

Baseada em sessão via Better Auth. Inclua credenciais nas requests:

```typescript
fetch('/api/chats', { credentials: 'include' });
```

O frontend usa Eden Treaty, que lida com isso automaticamente.

Para automação fora do navegador, use chaves de API com escopo (`x-api-key`). Veja
[`external-api.md`](./external-api.md) para habilitação, escopos, erros e exemplos.

### Endpoints De Auth

| Método | Path                 | Finalidade         |
| ------ | -------------------- | ------------------ |
| `POST` | `/api/auth/sign-up`  | Criar conta        |
| `POST` | `/api/auth/sign-in`  | Fazer login        |
| `GET`  | `/api/auth/session`  | Obter sessão atual |
| `POST` | `/api/auth/sign-out` | Fazer logout       |

## Endpoints De Chat

| Método   | Path             | Auth | Finalidade                      |
| -------- | ---------------- | ---- | ------------------------------- |
| `GET`    | `/api/chats`     | Sim  | Listar chats do usuário         |
| `POST`   | `/api/chats`     | Sim  | Criar novo chat                 |
| `GET`    | `/api/chats/:id` | Sim  | Obter detalhes do chat          |
| `PATCH`  | `/api/chats/:id` | Sim  | Atualizar chat (título, modelo) |
| `DELETE` | `/api/chats/:id` | Sim  | Deletar chat                    |

## Endpoints De Mensagem

| Método | Path                          | Auth | Finalidade               |
| ------ | ----------------------------- | ---- | ------------------------ |
| `GET`  | `/api/chats/:chatId/messages` | Sim  | Listar mensagens do chat |
| `POST` | `/api/chats/:chatId/messages` | Sim  | Criar uma mensagem       |

## Endpoints De Atividade

| Método | Path            | Auth | Finalidade                           |
| ------ | --------------- | ---- | ------------------------------------ |
| `GET`  | `/api/activity` | Sim  | Paginar o feed de atividade da conta |

Query: `since` (epoch ms, exclusivo), `workdir`, `limit` (≤100, padrão 30),
`cursor`. Retorna `ListActivityResponse` de `@mangostudio/shared/activity` —
`events` do mais recente para o mais antigo, mais `nextCursor` quando ainda há
páginas. O cursor é um token keyset opaco; não construa um.

Linhas que a versão em execução não consegue revalidar contra
`ActivityEventSchema` são omitidas de `events` em vez de derrubar a requisição,
para que um downgrade leia o feed de uma versão mais nova sem perder o resto
dele. A paginação continua avançando por elas.

## Endpoints De Geração

| Método | Path                  | Auth | Finalidade                      |
| ------ | --------------------- | ---- | ------------------------------- |
| `POST` | `/api/respond`        | Sim  | Resposta de texto sem streaming |
| `POST` | `/api/respond/stream` | Sim  | Resposta de texto via SSE       |
| `POST` | `/api/generate-image` | Sim  | Geração direta de imagem        |

### Body Do Request De Streaming

```json
{
  "chatId": "string",
  "prompt": "string",
  "thinkingEnabled": true,
  "reasoningEffort": "medium",
  "toolIntent": false,
  "modelId": "gemini-2.5-flash",
  "attachmentIds": []
}
```

### Resposta De Streaming

SSE com `Content-Type: text/event-stream`. Veja [../architecture/streaming.md](../architecture/streaming.md) para o catálogo de eventos.

## Endpoints De Settings

### App Settings

| Método | Path                | Auth | Finalidade             |
| ------ | ------------------- | ---- | ---------------------- |
| `GET`  | `/api/settings/app` | Sim  | Obter app settings     |
| `PUT`  | `/api/settings/app` | Sim  | Atualizar app settings |

### Connectors

| Método   | Path                                  | Auth | Finalidade                    |
| -------- | ------------------------------------- | ---- | ----------------------------- |
| `GET`    | `/api/settings/connectors`            | Sim  | Listar connectors             |
| `POST`   | `/api/settings/connectors`            | Sim  | Adicionar connector           |
| `DELETE` | `/api/settings/connectors/:id`        | Sim  | Remover connector             |
| `PUT`    | `/api/settings/connectors/:id/models` | Sim  | Atualizar modelos habilitados |

### Provider Settings

| Método | Path                                | Auth | Finalidade                     |
| ------ | ----------------------------------- | ---- | ------------------------------ |
| `GET`  | `/api/settings/providers`           | Sim  | Listar descritores de provedor |
| `GET`  | `/api/settings/providers/:provider` | Sim  | Obter descritor do provedor    |
| `PUT`  | `/api/settings/providers/:provider` | Sim  | Atualizar provider settings    |

### Tool Settings

| Método | Path                            | Auth | Finalidade                 |
| ------ | ------------------------------- | ---- | -------------------------- |
| `GET`  | `/api/settings/tools`           | Sim  | Listar descritores de tool |
| `PUT`  | `/api/settings/tools/:toolName` | Sim  | Atualizar tool settings    |

### Agent Settings

| Método   | Path                            | Auth | Finalidade                        |
| -------- | ------------------------------- | ---- | --------------------------------- |
| `GET`    | `/api/settings/agents`          | Sim  | Listar perfis de agente           |
| `GET`    | `/api/settings/agents/:agentId` | Sim  | Obter um perfil de agente         |
| `PUT`    | `/api/settings/agents/:agentId` | Sim  | Atualizar um agente               |
| `POST`   | `/api/settings/agents`          | Sim  | Criar um agente de usuário        |
| `DELETE` | `/api/settings/agents/:agentId` | Sim  | Remover um agente de usuário      |
| `POST`   | `/api/settings/agents/preview`  | Sim  | Pré-visualizar markdown de agente |

### Prompt Rules

| Método | Path                          | Auth | Finalidade                       |
| ------ | ----------------------------- | ---- | -------------------------------- |
| `GET`  | `/api/settings/rules`         | Sim  | Listar arquivos de regra         |
| `GET`  | `/api/settings/rules/preview` | Sim  | Pré-visualizar conteúdo da regra |

## Endpoints De Machine

A máquina do próprio hub: qual processo está servindo, se uma unidade de serviço
o mantém vivo, o que o doctor diz e as duas ações que mudam qualquer um dos dois.

| Método | Path                   | Auth | Finalidade                                                  |
| ------ | ---------------------- | ---- | ----------------------------------------------------------- |
| `GET`  | `/api/machine/status`  | Sim  | Processo do hub, unidade, runtime irmão, slot host e ações  |
| `GET`  | `/api/machine/doctor`  | Sim  | Linhas do doctor com contagem de avisos e falhas            |
| `GET`  | `/api/machine/logs`    | Sim  | Fim do arquivo de log da instância em execução              |
| `POST` | `/api/machine/restart` | Sim  | Reinicia o servidor do jeito que ele foi iniciado (`202`)   |
| `POST` | `/api/machine/service` | Sim  | `{ "action": "install" \| "uninstall" }` da unidade (`202`) |

`doctor` aceita `?sections=environments,library`; uma seção desconhecida é `422`
`VALIDATION`. `logs` aceita `?tail=` entre 1 e 2000, com padrão 200.

Os dois POSTs só respondem em loopback: de qualquer outro lugar são `403`
`PERMISSION_DENIED` com `details.reasons`. Uma ação que não se aplica ao modo como
o hub está rodando é `409` `UNSUPPORTED` com `details.reason` e `details.command`
— a linha da CLI para rodar no lugar.

## Endpoints De Upload

| Método | Path          | Auth | Finalidade                |
| ------ | ------------- | ---- | ------------------------- |
| `POST` | `/api/upload` | Sim  | Enviar arquivo attachment |

## Arquivos Estáticos

| Método | Path                | Finalidade                  |
| ------ | ------------------- | --------------------------- |
| `GET`  | `/images/:filename` | Servir imagens geradas      |
| `GET`  | `/uploads/:path`    | Servir attachments enviados |

## Formato Da Resposta De Erro

Todos os erros da API seguem o shape `ApiErrorResponse`:

```json
{
  "error": "Chat not found",
  "code": "NOT_FOUND"
}
```

`error` carrega a mensagem legível e `code` uma das constantes abaixo; o HTTP status fica na própria resposta. Falhas em campos específicos podem incluir um mapa opcional `details`.

Erros de streaming usam `SSEErrorEvent`:

```
data: {"type":"error","error":"Provider API error","done":true}
```

### Problem Details (RFC 9457)

Respostas de erro são negociadas por conteúdo. `ApiErrorResponse` continua sendo
o padrão, então um cliente que não envia nada, envia `*/*` ou
`application/json` continua recebendo o body acima. Um cliente que nomeia
`application/problem+json` no `Accept` recebe a mesma falha como um documento
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457):

```http
GET /api/chats/does-not-exist
Accept: application/problem+json, application/json;q=0.9
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json;charset=utf-8
Vary: Accept
```

```json
{
  "type": "https://mangostudio.dev/problems/not-found",
  "title": "Not found",
  "status": 404,
  "detail": "Chat not found",
  "code": "NOT_FOUND"
}
```

As duas representações são geradas a partir de uma única classificação, então
nada além da forma muda:

- o HTTP status é idêntico, e `status` sempre é igual a ele;
- `code` é a mesma constante, carregada como membro de extensão da RFC;
- `detail` é a mesma string que `error` carregaria, com a mesma sanitização;
- `details` é repassado sem alteração quando o endpoint reporta um;
- `type` é um identificador público estável por código de erro — compare-o, não
  faça dereference. Bodies sem código reconhecido usam `about:blank`;
- `instance` nunca é emitido; MangoStudio não tem um identificador público de
  request.

Respostas que participam carregam `Vary: Accept` em qualquer representação, para
que um cache compartilhado não entregue a um cliente o body do outro.

Duas coisas ficam fora da negociação. SSE mantém `SSEErrorEvent` — é um stream
de eventos, não uma resposta HTTP de erro. E alguns endpoints respondem 4xx com
um erro *mais* dados de domínio, como uma recusa de instalação carregando sua
`recipe`; esses mantêm o shape documentado em qualquer `Accept`, porque a
conversão é definida apenas sobre bodies que são exatamente um
`ApiErrorResponse`. A RFC 9457 permitiria esses campos como membros de extensão
— o mesmo mecanismo que `code` e `details` já usam — mas converter um body que
este contrato não descreve significaria criar uma extensão privada por endpoint,
então essas respostas são deixadas intactas.

`Accept: application/problem+json;q=0` recusa explicitamente. Quando os dois
media types são nomeados, o maior `q` vence.

O documento OpenAPI gerado em `/scalar/json` lista os dois media types em toda
resposta de erro que participa, e publica o schema como
`components.schemas.ProblemDetails`.

### Códigos De Erro Comuns

| Código           | HTTP Status | Significado                               |
| ---------------- | ----------- | ----------------------------------------- |
| `UNAUTHORIZED`   | 401         | Sessão ausente ou inválida                |
| `OWNERSHIP`      | 403         | Recurso não pertence ao usuário           |
| `NOT_FOUND`      | 404         | Recurso não existe                        |
| `VALIDATION`     | 422         | Body de request ou semântica inválida     |
| `RATE_LIMITED`   | 429         | Muitas requisições (ver `Retry-After`)    |
| `INTERNAL`       | 500         | Erro inesperado do servidor               |
| `PROVIDER_ERROR` | 502 / 503   | Provedor de modelo falhou ou indisponível |
