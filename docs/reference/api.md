# API Reference

MangoStudio exposes a REST API under `/api/` and an SSE streaming endpoint.

`@mangostudio/shared` contracts are the source of truth for request and
response types. This page is a contributor-facing map of the current surface,
not a generated OpenAPI reference.

## Base URL

```
http://localhost:3001/api
```

## Authentication

Session-based via Better Auth. Include credentials in requests:

```typescript
fetch('/api/chats', { credentials: 'include' });
```

The frontend uses Eden Treaty which handles this automatically.

For automation outside the browser, use scoped API keys (`x-api-key`). See
[`external-api.md`](./external-api.md) for enablement, scopes, errors, and
examples.

### Auth Endpoints

| Method | Path                 | Purpose             |
| ------ | -------------------- | ------------------- |
| `POST` | `/api/auth/sign-up`  | Create account      |
| `POST` | `/api/auth/sign-in`  | Log in              |
| `GET`  | `/api/auth/session`  | Get current session |
| `POST` | `/api/auth/sign-out` | Log out             |

## Chat Endpoints

| Method   | Path                   | Auth | Purpose                    |
| -------- | ---------------------- | ---- | -------------------------- |
| `GET`    | `/api/chats`           | Yes  | List user's chats          |
| `POST`   | `/api/chats`           | Yes  | Create new chat            |
| `GET`    | `/api/chats/:id`       | Yes  | Get chat details           |
| `PATCH`  | `/api/chats/:id`       | Yes  | Update chat (title, model) |
| `DELETE` | `/api/chats/:id`       | Yes  | Delete chat                |
| `GET`    | `/api/chats/:id/todos` | Yes  | Current todo list state    |

`GET /api/chats/:id/todos` returns `{ todos, updatedAt }` (`ChatTodosResponse` from
`@mangostudio/shared/todos`); `updatedAt` is `null` when the chat has no todo list yet.
The list is kept live during streaming by the `todo_update` SSE chunk.

## Message Endpoints

| Method | Path                          | Auth | Purpose                 |
| ------ | ----------------------------- | ---- | ----------------------- |
| `GET`  | `/api/chats/:chatId/messages` | Yes  | List messages in a chat |
| `POST` | `/api/chats/:chatId/messages` | Yes  | Create a message        |

## Generation Endpoints

| Method | Path                  | Auth | Purpose                     |
| ------ | --------------------- | ---- | --------------------------- |
| `POST` | `/api/respond`        | Yes  | Non-streaming text response |
| `POST` | `/api/respond/stream` | Yes  | SSE streaming text response |
| `POST` | `/api/generate-image` | Yes  | Direct image generation     |

### Streaming Request Body

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

### Streaming Response

SSE with `Content-Type: text/event-stream`. See [../architecture/streaming.md](../architecture/streaming.md) for the event catalog.

## Settings Endpoints

### App Settings

| Method | Path                | Auth | Purpose             |
| ------ | ------------------- | ---- | ------------------- |
| `GET`  | `/api/settings/app` | Yes  | Get app settings    |
| `PUT`  | `/api/settings/app` | Yes  | Update app settings |

### Connectors

| Method   | Path                                  | Auth | Purpose               |
| -------- | ------------------------------------- | ---- | --------------------- |
| `GET`    | `/api/settings/connectors`            | Yes  | List connectors       |
| `POST`   | `/api/settings/connectors`            | Yes  | Add connector         |
| `DELETE` | `/api/settings/connectors/:id`        | Yes  | Remove connector      |
| `PUT`    | `/api/settings/connectors/:id/models` | Yes  | Update enabled models |

### Provider Settings

| Method | Path                                | Auth | Purpose                   |
| ------ | ----------------------------------- | ---- | ------------------------- |
| `GET`  | `/api/settings/providers`           | Yes  | List provider descriptors |
| `GET`  | `/api/settings/providers/:provider` | Yes  | Get provider descriptor   |
| `PUT`  | `/api/settings/providers/:provider` | Yes  | Update provider settings  |

### Tool Settings

| Method | Path                            | Auth | Purpose               |
| ------ | ------------------------------- | ---- | --------------------- |
| `GET`  | `/api/settings/tools`           | Yes  | List tool descriptors |
| `PUT`  | `/api/settings/tools/:toolName` | Yes  | Update tool settings  |

### Agent Settings

| Method   | Path                            | Auth | Purpose                |
| -------- | ------------------------------- | ---- | ---------------------- |
| `GET`    | `/api/settings/agents`          | Yes  | List agent profiles    |
| `GET`    | `/api/settings/agents/:agentId` | Yes  | Get an agent profile   |
| `PUT`    | `/api/settings/agents/:agentId` | Yes  | Update an agent        |
| `POST`   | `/api/settings/agents`          | Yes  | Create a user agent    |
| `DELETE` | `/api/settings/agents/:agentId` | Yes  | Delete a user agent    |
| `POST`   | `/api/settings/agents/preview`  | Yes  | Preview agent markdown |

### Prompt Rules

| Method | Path                          | Auth | Purpose                   |
| ------ | ----------------------------- | ---- | ------------------------- |
| `GET`  | `/api/settings/rules`         | Yes  | List rule files           |
| `GET`  | `/api/settings/rules/preview` | Yes  | Preview rule file content |

## Upload Endpoints

| Method | Path          | Auth | Purpose                |
| ------ | ------------- | ---- | ---------------------- |
| `POST` | `/api/upload` | Yes  | Upload attachment file |

## Static Files

| Method | Path                | Purpose                    |
| ------ | ------------------- | -------------------------- |
| `GET`  | `/images/:filename` | Serve generated images     |
| `GET`  | `/uploads/:path`    | Serve uploaded attachments |

## Error Response Format

All API errors follow the `ApiErrorResponse` shape:

```json
{
  "error": "Chat not found",
  "code": "NOT_FOUND"
}
```

`error` carries the human-readable message and `code` one of the constants below; the HTTP status is on the response itself. Field-level failures may add an optional `details` map.

Streaming errors use `SSEErrorEvent`:

```
data: {"type":"error","error":"Provider API error","done":true}
```

### Common Error Codes

| Code             | HTTP Status | Meaning                                    |
| ---------------- | ----------- | ------------------------------------------ |
| `UNAUTHORIZED`   | 401         | Missing or invalid session                 |
| `OWNERSHIP`      | 403         | Resource not owned by the user             |
| `NOT_FOUND`      | 404         | Resource does not exist                    |
| `VALIDATION`     | 422         | Invalid request body or semantics          |
| `RATE_LIMITED`   | 429         | Too many requests (see `Retry-After`)      |
| `INTERNAL`       | 500         | Unexpected server error                    |
| `PROVIDER_ERROR` | 502 / 503   | Upstream model provider failed/unavailable |
