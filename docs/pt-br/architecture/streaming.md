# Arquitetura De Streaming

As respostas do chat são entregues via Server-Sent Events (SSE) sobre uma única conexão HTTP. O frontend consome o stream usando `ReadableStream` da Fetch API e mapeia os eventos para atualizações de UI.

## Catálogo De Eventos SSE

`StreamChunk` é a union pública em [`streaming/schemas.ts`](../../../apps/shared/src/streaming/schemas.ts), discriminada por `type`. A tabela cobre turnos internos; os eventos de agentes externos estão abaixo:

| Evento                                              | Direção         | Finalidade                                          |
| --------------------------------------------------- | --------------- | --------------------------------------------------- |
| `user_message_id`                                   | Server → Client | ID da mensagem do usuário persistida no turno       |
| `assistant_message_id`                              | Server → Client | ID persistido da mensagem do assistente             |
| `thinking_start`                                    | Server → Client | Modelo inicia reasoning/thinking                    |
| `thinking`                                          | Server → Client | Deltas de tokens de reasoning                       |
| `text`                                              | Server → Client | Deltas de texto do modelo                           |
| `tool_call_started`                                 | Server → Client | Modelo inicia uma chamada de tool                   |
| `tool_call_completed`                               | Server → Client | Argumentos da tool foram recebidos por completo     |
| `tool_result`                                       | Server → Client | Resultado da execução da tool                       |
| `tool_execution`                                    | Server → Client | Snapshot completo do ciclo de execução              |
| `subagent_started`                                  | Server → Client | Delegação a subagente iniciada                      |
| `subagent_text`                                     | Server → Client | Deltas de texto do subagente                        |
| `subagent_tool_call_started`                        | Server → Client | Subagente iniciou uma tool aninhada                 |
| `subagent_completed`                                | Server → Client | Subagente concluiu com sucesso                      |
| `subagent_failed`                                   | Server → Client | Subagente falhou                                    |
| `image_generation_started`                          | Server → Client | Geração de imagem iniciada (via tool)               |
| `image_generation_completed`                        | Server → Client | Imagem gerada com sucesso                           |
| `image_generation_failed`                           | Server → Client | Falha na geração de imagem                          |
| `mcp_media`                                         | Server → Client | Tool MCP produziu mídia rica persistida             |
| `question`                                          | Server → Client | Perguntas estruturadas para o usuário               |
| `mcp_elicitation_request`, `mcp_elicitation_status` | Server → Client | Solicitação e resolução de input MCP                |
| `todo_update`                                       | Server → Client | Lista de todos do chat substituída                  |
| `context_info`                                      | Server → Client | Uso de tokens e status da janela de contexto        |
| `fallback_notice`                                   | Server → Client | Notificação de degradação da continuação            |
| `continuation_transition`                           | Server → Client | Transição de modo de continuação                    |
| `system_event`                                      | Server → Client | Marcadores de timeline (ex.: loop de tool esgotado) |
| `done`                                              | Server → Client | Turno concluído                                     |
| `error`                                             | Server → Client | Erro fatal                                          |

Turnos externos usam `external_session_started`, `external_text`,
`external_reasoning_started`, `external_reasoning`, `external_reasoning_ended`,
`external_activity_started`, `external_activity_updated`, `external_activity_completed`,
`external_approval_request`, `external_approval_status`, `external_usage`,
`external_thread_usage`, `external_commands`, `external_account_limits`, `external_steer`,
`external_error`, `external_notice` e `external_turn_completed`. Os payloads e limites estão no mesmo schema. `external_turn_completed` e `external_error` têm `done: false`; o stream termina com `done` ou `error` terminal.

## Ciclo De Vida Dos Eventos

Um turno típico com chamada de tools:

```
user_message_id
assistant_message_id
thinking_start
thinking (deltas...)
tool_call_started
tool_call_completed
tool_result (um por tool call)
text (deltas...)
context_info
done
```

Se a continuação degrada, por exemplo quando o provedor ou modelo mudou:

```
fallback_notice
continuation_transition (recovered: false)
  ... eventos normais ...
continuation_transition (recovered: true)
done
```

## Formato Wire Do SSE

```
: keepalive

data: {"type":"user_message_id","messageId":"msg_abc123","done":false}

data: {"type":"text","text":"Hello","done":false}

data: {"type":"done","done":true}
```

- Cada evento é enquadrado como `data: <JSON>\n\n`.
- Um comentário keepalive (`: keepalive\n\n`) é enviado a cada 5 segundos em `/api/respond/stream` (turnos internos e externos), via `generation/application/sse-keepalive.ts`. O helper geral `lib/sse-stream.ts`, usado por outras rotas SSE, usa 15 segundos para evitar timeouts em proxies.
- Todo evento carrega um campo `done`; o evento final usa `done: true`.
- Os eventos são encerrados por uma linha em branco dupla.

## Implementação No Servidor

### Rota (`respond-stream-routes.ts`)

`POST /api/respond/stream` com body validado por `RespondStreamBodySchema`:

```typescript
import type { RespondStreamBody } from '@mangostudio/shared/generation';

const request: RespondStreamBody = {
  chatId: 'chat-id',
  prompt: 'Hello',
  // model: '<configured model ID>',
  // toolIntent: 'image_generation_requested',
};
```

Campos obrigatórios: `chatId` e `prompt`. Opcionais: `attachmentIds`, `model`, `systemPrompt`, `promptSettings`, `thinkingEnabled`, `reasoningEffort`, `thinkingVisibility`, `maxToolIterations`, `contextSettings`, `toolIntent`, `agentId`, `externalTurn` e `recovery`. Consulte [`RespondStreamBodySchema`](../../../apps/shared/src/generation/schemas.ts) para formatos e limites. `toolIntent`, quando presente, é o literal `image_generation_requested`.

**Validações prévias** que retornam erro HTTP antes dos headers SSE:

1. Verificação de ownership do chat → 404.
2. Validação de conteúdo, como prompt não vazio e attachments disponíveis → 400.
3. Resolução do modelo, garantindo que provedor exista e modelo esteja disponível → 503/400.

**Resposta SSE** define headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.

### Orquestrador (`stream-text-turn.ts`)

O async generator principal que dirige o turno:

1. **Setup** — Persiste a mensagem do usuário, resolve modelo/provedor e compõe prompt rules.
2. **Decisão de continuação** — Consulta `chats.lastProviderState` para decidir entre continuação por cursor ou replay.
3. **Loop agentic** — Chama `provider.generateAgentTurnStream()` em iterações:
   - Mapeia eventos do provedor para eventos públicos em `stream-text-turn-stages.ts`; `tool_call_arguments_delta` e `assistant_text_delta` internos não são tipos wire públicos.
   - Ao receber tool calls, executa tools e devolve os resultados.
   - Em `turn_completed`, calcula o snapshot de contexto, persiste o estado e produz `done`.
4. **Fallback** — Se o provedor não suportar streaming agentic, cai para `generateTextStream()` ou `generateText()`.

## Consumo No Frontend

### Camada De Serviço (`generation-service.ts`)

Streaming bruto baseado em `fetch` usando `ReadableStream`:

```typescript
const response = await fetch('/api/respond/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(request), // RespondStreamBody
  credentials: 'include',
  signal,
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
if (!response.body) throw new Error('Missing response body');

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let terminal = false;

try {
  while (true) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

    // Keep partial frames (including split data prefixes/JSON) for the next read.
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue; // Ignore comment-only keepalive frames.
      const chunk = JSON.parse(data); // StreamChunk; validate untrusted peers.
      onChunk(chunk);
      terminal ||= chunk.done === true; // Both done and error can terminate a turn.
    }

    if (done) break;
  }
  // An incomplete frame at EOF is never dispatched.
  if (!terminal) throw new Error('Stream ended before a terminal event');
} finally {
  reader.releaseLock();
}
```

Este exemplo consome frames SSE completos e informa ausência de evento terminal no EOF. É testado diretamente nos dois guias com frames inteiros, prefixos divididos, JSON/UTF-8 dividido e CRLF. O parser de produção em `generation-service.ts` já mantém um buffer persistente de linhas; a correção do exemplo não diagnostica desconexões de produção.

### Hook (`use-chat-stream.ts`)

Hook React que gerencia o ciclo de vida do stream:

- `isGenerating` / `setIsGenerating` — Toggle do estado de carregamento.
- `handleStop()` — Aborta o stream via `AbortController`.
- `contextInfo` / `fallbackNotice` — Estado rastreado para notificações de contexto/degradação.
- `contextCache` — Cache cross-chat das informações de contexto.

## Tratamento De Erros

- **Erros pré-stream** — Retornam respostas HTTP JSON padrão com códigos tipados.
- **Erros do stream** — `SSEErrorEvent` com `done: true`: `{ type: 'error', error: string, done: true }`. Um agente externo que não conseguiu iniciar pode acrescentar `unavailableReason`, `remedy` e, para um agente desatualizado, `requiredVersion`, e `code` para uma abertura que falhou, que é o `external_agent_*` do runtime (o limite de sessões tem texto próprio no cliente; os demais mostram o tipo como texto simples ao lado da frase) (veja "A send refused while the session opens" em `docs/architecture/external-agents.md`); `error` continua sendo o texto em inglês de reserva.
- **Perda de conexão** — O frontend detecta `reader.read()` retornando `done: true` sem um evento `done` anterior e exibe um erro de fallback.
- **Abort** — A interrupção acionada pelo usuário envia `AbortSignal`; o servidor faz a limpeza via `AbortController` passado ao generator.

## Eventos De Continuação

Veja [`continuation.md`](./continuation.md) para a arquitetura completa de continuação. Eventos principais de streaming:

- **`fallback_notice`** — Emitido quando a continuação degrada, como mudança de provedor/modelo/prompt ou cursor expirado. O frontend exibe uma toast notification.
- **`continuation_transition`** — Persistido em message parts. Carrega `recovered: false` durante o turno e é alterado para `recovered: true` em caso de sucesso.
- **`context_info`** — Razão de uso de tokens e severidade. O frontend atualiza o context ring e pode mostrar o callout de compactação.
