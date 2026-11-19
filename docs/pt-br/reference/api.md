# Referência Da API

O MangoStudio expõe uma API REST em `/api/` e um endpoint de streaming SSE.

Os contratos de `@mangostudio/shared` são a fonte de verdade para tipos de request e response. Esta página é um mapa voltado a contribuidores da superfície atual, não uma referência OpenAPI gerada.

## Navegação de áreas relacionadas

Para Library, tarefas por chat, ambientes, agentes externos, MCP e terminal,
consulte os [mapas de arquivos e fallbacks](./agent-playbooks.md#navegação-e-fallbacks-em-inglês).
Os guias de [MCP](../../reference/mcp.md), [hub/runtime](../../architecture/hub-runtime.md)
e [Mango Protocol](../../protocol/README.md) estão em inglês. A
[lista de lacunas de tradução](../../README.md#portuguese-coverage-and-english-fallbacks)
cobre as demais páginas sem contraparte PT.

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

| Método | Path                      | Finalidade         |
| ------ | ------------------------- | ------------------ |
| `POST` | `/api/auth/sign-up/email` | Criar conta        |
| `POST` | `/api/auth/sign-in/email` | Fazer login        |
| `GET`  | `/api/auth/get-session`   | Obter sessão atual |
| `POST` | `/api/auth/sign-out`      | Fazer logout       |

## Endpoints De Chat

| Método   | Path             | Auth | Finalidade                      |
| -------- | ---------------- | ---- | ------------------------------- |
| `GET`    | `/api/chats`     | Sim  | Paginar chats do usuário        |
| `GET`    | `/api/chats/:id` | Sim  | Um chat pelo id                 |
| `POST`   | `/api/chats`     | Sim  | Criar novo chat                 |
| `PUT`    | `/api/chats/:id` | Sim  | Atualizar chat (título, modelo) |
| `DELETE` | `/api/chats/:id` | Sim  | Deletar chat                    |

`GET /api/chats` devolve uma página, `{ items, nextCursor }` (`ChatListPage` de
`@mangostudio/shared/chat`), da atualização mais recente para a mais antiga. `limit` vai de 1 a 100
(padrão 50). Envie o `nextCursor` da página anterior como `cursor` para ler a próxima; `nextCursor`
é `null` na última página. Um `cursor` malformado responde 400 com `code: "VALIDATION"`.

`q` mantém só os chats cujo título, nome da pasta do workdir (o último segmento do caminho) ou
rótulo do runner (`mango` para o runner embutido, o id do alvo para um fornecedor) o contenha. A
comparação é por substring literal (`%` e `_` são caracteres comuns), ignora maiúsculas ASCII, aparas
de espaço nas pontas são removidas, e um `q` em branco lista tudo. `q` tem no máximo 100 caracteres
(`CHAT_SEARCH_MAX_LENGTH`), senão 422. Os resultados paginam com o mesmo `limit` e `cursor`. Uma
busca por substring não usa índice: o SQLite percorre os chats da conta do mais novo ao mais antigo e
testa cada um até encher a página. Um termo comum volta após as primeiras linhas; um termo raro ou
ausente lê todos os chats da conta (cerca de 5 ms com 2.000 chats e 21 ms com 10.000 na máquina de
desenvolvimento).

`GET /api/chats/:id` devolve o chat como a lista o mostra, para um cliente que guarda só algumas
páginas da lista. Um chat inexistente e um chat de outra conta respondem igualmente 404 com
`code: "NOT_FOUND"`.

Atualize um chat com `PUT /api/chats/:id` e `UpdateChatBodySchema`.

## Endpoints De Mensagem

| Método | Path                          | Auth | Finalidade               |
| ------ | ----------------------------- | ---- | ------------------------ |
| `GET`  | `/api/chats/:chatId/messages` | Sim  | Listar mensagens do chat |
| `GET`  | `/api/messages/images`        | Sim  | Paginar a galeria        |
| `POST` | `/api/messages`               | Sim  | Criar uma mensagem       |

O `GET` pagina a transcrição (`MessagesPage` de `@mangostudio/shared/chat`). Query: `limit`
(inteiro de 1 a 100, padrão 50; qualquer outro valor é recusado com 422), `cursor` e `order` — `asc` (o padrão) lê a partir da mensagem mais antiga, `desc`
a partir da mais nova. Em ambas as ordens a página é cronológica, da mais antiga para a mais
nova: `order` escolhe qual janela da transcrição a página é, e `nextCursor` aponta a borda da
página voltada para as mensagens ainda não lidas (a última mensagem em `asc`, a primeira em
`desc`), `null` na última página. O frontend abre um chat com `order=desc` e pede as páginas
mais antigas conforme a pessoa rola para cima.

O cursor é uma posição `(timestamp, rowid)` opaca, não uma direção: o emitido sob uma ordem é
lido como posição pela outra. Um timestamp numérico puro de uma build antiga ainda é aceito
(depois de toda mensagem daquele timestamp em `asc`, antes de toda uma delas em `desc`); um
cursor vazio ou malformado é rejeitado com 400, e um `order` desconhecido com 422, como
qualquer query que o schema recusa.

`GET /api/messages/images` pagina a galeria de imagens geradas (`GalleryPage` de `@mangostudio/shared/chat`). Query: `cursor` e `limit`, com os mesmos limites da transcrição: inteiro de 1 a 100, padrão 50, e 422 para qualquer outro valor. `nextCursor` é `null` na última página.

Atualize uma mensagem com `PUT /api/messages/:id` e `UpdateMessageBodySchema`. Um patch de `text` em uma mensagem cujo turno ainda está gerando responde 409 `CONFLICT`, porque o escritor do turno continua estendendo o texto que gravou; envie `isGenerating: false` no mesmo patch ou edite depois que o turno terminar.

Crie mensagens com `POST /api/messages` e `CreateMessageBodySchema`: `id`, `chatId`, `role`, `text` e `timestamp` obrigatórios; consulte o schema compartilhado de chat para campos opcionais.

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
| `POST` | `/api/generate`       | Sim  | Geração direta de imagem        |

A geração direta usa `GenerateImageBodySchema`: `chatId` e `prompt` obrigatórios; `model`, `systemPrompt`, `promptSettings`, `referenceImageUrl` e `imageQuality` opcionais. Os schemas de geração ficam em `apps/shared/src/generation/schemas.ts`. Selecione `model` no catálogo configurado; o placeholder abaixo não recomenda um modelo de fornecedor.

### Body Do Request De Streaming

```json
{
  "chatId": "string",
  "prompt": "string",
  "thinkingEnabled": true,
  "reasoningEffort": "medium",
  "toolIntent": "image_generation_requested",
  "model": "<configured-model-id>",
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

| Método | Path                                | Auth | Finalidade                       |
| ------ | ----------------------------------- | ---- | -------------------------------- |
| `GET`  | `/api/settings/rule-files/defaults` | Sim  | Listar arquivos de regra         |
| `POST` | `/api/settings/rule-files/preview`  | Sim  | Pré-visualizar conteúdo da regra |

O body de preview é `{ "path": "~/.mango/AGENTS.md" }` (`RuleFilePreviewBodySchema`); defaults retorna descritores, não o conteúdo dos arquivos.

Todo descritor traz em `locationId` a location da Library pela qual o arquivo é lido. Os dois arquivos embutidos são `mango-instructions` e `claude-instructions` do registry, então seus caminhos seguem `MANGOSTUDIO_CONFIG_HOME` e `CLAUDE_CONFIG_DIR` como a Library. Um caminho informado pelo usuário é `custom-instruction`: somente leitura, nunca um destino de escrita e fora da matriz da Library.

## Endpoints De Machine

A máquina do próprio hub: qual processo está servindo, se uma unidade de serviço
o mantém vivo, resultados do doctor, configuração e ações de atualização.

| Método | Path                   | Auth | Finalidade                                                                  |
| ------ | ---------------------- | ---- | --------------------------------------------------------------------------- |
| `GET`  | `/api/machine/status`  | Sim  | Processo do hub, unidade, runtime irmão, slot host e ações                  |
| `GET`  | `/api/machine/update`  | Sim  | Disponibilidade de atualização do hub                                       |
| `GET`  | `/api/machine/doctor`  | Sim  | Linhas do doctor com contagem de avisos e falhas                            |
| `GET`  | `/api/machine/logs`    | Sim  | Fim do arquivo de log da instância em execução                              |
| `POST` | `/api/machine/restart` | Sim  | Reinicia o servidor do jeito que ele foi iniciado (`202`)                   |
| `POST` | `/api/machine/service` | Sim  | `{ "action": "install" \| "uninstall" }` da unidade (`202`)                 |
| `POST` | `/api/machine/config`  | Sim  | Habilita installs com `{ "environments": { "installsEnabled": true } }`     |
| `POST` | `/api/machine/upgrade` | Sim  | Request: `channel`, `version` (stable), `sha` (canary), `restart` opcionais |

`doctor` aceita `?sections=environments,library`; uma seção desconhecida é `422`
`VALIDATION`. Suas linhas são limitadas à conta autenticada: servidores MCP,
conectores e toggles de skills pertencem a um usuário, não à máquina, então a
página de uma conta nunca cita as de outra. O `mangostudio doctor` não tem esse
limite — ele roda no teclado da própria máquina e relata a instalação inteira.
`logs` aceita `?tail=` entre 1 e 2000, com padrão 200. Ele lê um
sufixo limitado do arquivo, não o arquivo inteiro, então um log com linhas
excepcionalmente longas pode responder com menos linhas do que as pedidas;
`truncated` diz se o arquivo tem mais.

Os POSTs de ação e `GET /api/machine/logs` só respondem em loopback (o log é a saída bruta
do processo, sem redação): de qualquer outro lugar são `403`
`PERMISSION_DENIED` com `details.reasons`. "Loopback" é o peer do socket, a menos
que `trustProxy` esteja ligado: atrás de um reverse proxy o peer é o proxy para
todo chamador, então lá o guard lê o cliente encaminhado. Veja
[Confiar nos headers de proxy](../operations/deployment.md#confiar-nos-headers-de-proxy).
Uma ação que não se aplica ao modo como
o hub está rodando é `409` `UNSUPPORTED` com `details.reason` e `details.command`
— a linha da CLI para rodar no lugar.

O corpo do `202` é `{ accepted, outcome, unit? }`. `outcome` é um código —
`restarting-service`, `restarting-detached`, `service-installed-handover`,
`service-installed`, `service-removing` ou `service-removed` — e `unit` nomeia a
unidade do supervisor quando o desfecho fala de uma. Sem prosa: o hub não conhece
o idioma do navegador que pediu, então a página escreve cada código a partir dos
dicionários de i18n.

`POST /api/machine/config` retorna `MachineConfigWriteResponse` com HTTP 200. `POST /api/machine/upgrade` transmite progresso via SSE; usa `MachineUpgradeBodySchema` de `apps/shared/src/updates/schemas.ts`, enquanto config usa `MachineConfigWriteBodySchema` de `apps/shared/src/machine/schemas.ts`.

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
DELETE /api/chats/does-not-exist
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
um erro _mais_ dados de domínio, como uma recusa de instalação carregando sua
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

| Código                         | HTTP Status | Significado                                                                                                                                                     |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`                 | 401         | Sessão ausente ou inválida                                                                                                                                      |
| `OWNERSHIP`                    | 403         | Recurso não pertence ao usuário                                                                                                                                 |
| `NOT_FOUND`                    | 404         | Recurso não existe                                                                                                                                              |
| `VALIDATION`                   | 422         | Body de request ou semântica inválida                                                                                                                           |
| `RATE_LIMITED`                 | 429         | Muitas requisições (ver `Retry-After`)                                                                                                                          |
| `INTERNAL`                     | 500         | Erro inesperado do servidor                                                                                                                                     |
| `PROVIDER_ERROR`               | 502 / 503   | Provedor de modelo falhou ou indisponível                                                                                                                       |
| `PROVIDER_CREDENTIAL_REJECTED` | stream      | Um provedor respondeu 401 ou 403 à chave de um conector; corrija esse conector em Configurações (eventos de erro de stream e resultados de subagente com falha) |
| `ENVIRONMENT_UNAVAILABLE`      | 503         | O runtime do ambiente de destino está inacessível (`details.reason`; `Retry-After` quando há nova tentativa agendada)                                           |
