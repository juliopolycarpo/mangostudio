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
