# Canal De Invalidação Em Tempo Real

O MangoStudio expõe um WebSocket autenticado em `/api/ws` para que abas do
navegador saibam que dados em cache podem estar desatualizados. O canal
transporta apenas sinais de invalidação. Os endpoints HTTP continuam sendo a
fonte da verdade para leitura e escrita de entidades, e os clientes respondem
a uma invalidação buscando novamente a query afetada.

## Limites De Responsabilidade

- O endpoint aceita apenas sessões por cookie do Better Auth. Chaves de API são
  rejeitadas.
- As mensagens nunca contêm valores de settings, registros de chat, saída do
  Git ou outros payloads de entidades.
- A entrega é limitada por usuário e filtrada por tópico.
- O bus existe apenas no processo, sem persistência, replay ou fan-out entre
  workers.
- Uma indisponibilidade do WebSocket não pode impedir leituras ou escritas HTTP.

Os schemas e helpers compartilhados ficam em `apps/shared/src/realtime/`. A
ponte WebSocket fica em
`apps/api/src/modules/realtime/http/realtime-routes.ts`, e os produtores
publicam por `apps/api/src/services/realtime/realtime-bus.ts`.

## Ciclo De Vida Da Conexão

1. O upgrade resolve uma sessão por cookie do Better Auth e valida o `Origin`
   quando presente.
2. O socket ocupa uma das vagas de conexão do usuário autenticado.
3. A rota se inscreve no bus limitado ao usuário.
4. O servidor envia `{"type":"ready"}`. O cliente não deve assinar tópicos
   antes dessa mensagem.
5. Mensagens de subscribe autorizam cada tópico solicitado. Apenas tópicos
   recém-aceitos entram no conjunto ativo do socket. Quando pelo menos um
   tópico solicitado está ativo depois disso (recém-ativado ou já ativo), o
   servidor envia `{"type":"subscribed","topics":[...]}` com esse subconjunto
   ativo efetivo para o cliente atualizar o cache atrás dessa barreira —
   inclusive em re-subscribe idempotente de um conjunto já ativo.
6. Um evento do bus só é encaminhado quando o id de usuário corresponde à
   inscrição do socket e o tópico está ativo nele.
7. Fluxos de fechamento e falha removem o listener e a vaga de conexão de forma
   idempotente.

O listener é registrado antes de `ready`, portanto uma conexão confirmada não
perde eventos entre a confirmação e a inscrição no bus.

## Autenticação E Origins

O handshake do navegador usa o cookie de sessão existente do Better Auth. O
estado do socket guarda apenas o id de usuário confiável e os contadores da
conexão; não guarda cookie, token de sessão, headers do request ou material de
chave de API.

Um request com `x-api-key` não é aceito, mesmo que a chave possa ser resolvida
para um usuário. Autenticação ausente ou não permitida recebe uma mensagem de
erro `UNAUTHORIZED`, seguida do código de fechamento `4401`. Esse código é o
sinal estável para o cliente parar de reconectar e voltar ao fluxo normal de
autenticação.

Quando `Origin` está presente, ele deve corresponder a uma origin configurada
no CORS ou à origin pública do Better Auth. Uma origin de navegador não
permitida fecha com `4403`. A ausência de `Origin` é aceita para diagnósticos
fora do navegador, que ainda precisam fornecer uma sessão válida por cookie.

## Protocolo

Mensagens do cliente:

| Tipo          | Formato                                        | Comportamento                                                     |
| ------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| `subscribe`   | `{"type":"subscribe","topics":["settings"]}`   | Autoriza e ativa tópicos reconhecidos; confirma com `subscribed`. |
| `unsubscribe` | `{"type":"unsubscribe","topics":["settings"]}` | Remove tópicos reconhecidos; chamadas repetidas são seguras.      |
| `ping`        | `{"type":"ping"}`                              | Recebe `{"type":"pong"}`.                                         |

Uma mensagem de subscribe ou unsubscribe contém de 1 a 32 tópicos. Cada tópico
tem de 1 a 256 caracteres. A primeira mensagem malformada recebe um erro
`VALIDATION`; a segunda mensagem malformada no mesmo socket o fecha com `4400`.

As mensagens do servidor são `ready`, `subscribed`, `pong`, `invalidate` ou o
formato compartilhado de `ApiErrorResponse` estendido com `type: "error"`.

A autorização de tópicos Git pode aguardar ownership antes da ativação.
Invalidations publicadas nessa janela não são entregues; o cliente deve tratar
HTTP como fonte da verdade e atualizar as queries relevantes depois de
`subscribed` (e depois de `ready` na conexão/reconexão).

### Tópicos

| Tópico         | Autorização                            | Escopos opcionais                                                       |
| -------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `settings`     | Qualquer sessão autenticada por cookie | `app`, `provider`, `tool`, `tool-identity`                              |
| `environments` | Qualquer sessão autenticada por cookie | Nenhum                                                                  |
| `activity`     | Qualquer sessão autenticada por cookie | Nenhum                                                                  |
| `chats`        | Qualquer sessão autenticada por cookie | Nenhum                                                                  |
| `git:<chatId>` | O usuário deve ser dono de `<chatId>`  | `state`, `stashes`, `branches`, `history`, `commits`, `diffs`, `github` |
| `repo:<key>`   | Qualquer sessão autenticada por cookie | `state`, `stashes`, `branches`, `history`, `commits`, `diffs`, `github` |

`activity` é um único tópico para todos os tipos de evento, em vez de um por
produtor. O feed é uma única consulta, portanto um tópico por tipo apenas
convergiria de volta para a mesma invalidação. Ele é publicado pelo registrador
de atividade (`apps/api/src/modules/activity/application/record-activity.ts`), e
não pelos sete pontos de emissão, para que um novo tipo não consiga gravar uma
linha sobre a qual ninguém é avisado.

`chats` significa que um chat visível para a conta mudou: foi criado, editado,
excluído ou reposicionado na lista porque `chats.updatedAt` avançou. A lista de chats é o
único leitor de dados (a espera de reconciliação da transcrição também escuta,
para saber que um turno foi finalizado). É um tópico separado porque a lista e o
feed refazem a busca a cada frame recebido; em um tópico compartilhado, um commit
git refazia a busca da lista de chats e um turno cancelado refazia a do feed,
cada uma respondida com o que a aba já tinha. A API o publica por
`publishChatListInvalidation`
(`apps/api/src/services/realtime/chat-list-invalidation.ts`). Quem move
`chats.updatedAt` o anuncia no mesmo lugar, `updateChatAfterTurn` e
`persistImageTurn` em
`apps/api/src/modules/generation/infrastructure/conversation-persistence.ts`;
apenas a criação, a edição e a exclusão de chat, que não mexem nessa coluna, publicam por
conta própria. `chat-list-signal-boundary.test.ts` garante as duas regras.

`repo:<key>` é o equivalente, no escopo do repositório, de `git:<chatId>`. Uma
escrita de git ou GitHub publica os mesmos escopos nos dois: o frame por chat
alcança o chat que escreveu (e, nas escritas do GitHub, os chats ligados ao mesmo
workdir), e o frame do repositório alcança todos os chats da conta no mesmo
repositório, incluindo worktrees vinculadas e subdiretórios. Os dois são
publicados lado a lado, e um não substitui o outro, para que uma aba antiga, que
nunca aprende uma chave, continue funcionando com `git:<chatId>`; uma aba nova
que mantém ambos junta o par em uma única nova busca. Todo caminho de escrita o
publica: o serviço de escrita git, a administração de worktrees, as escritas do
GitHub, as mutações de arquivo das ferramentas de um turno e a conclusão do turno
(`apps/api/src/modules/git/application/repo-invalidation.ts`).

A chave é um digest opaco (URL-safe, no máximo 64 caracteres) do id do ambiente e
do diretório comum resolvido do repositório, o mesmo escopo que serializa as
mutações do repositório (`resolveRepoLockScope`). O Git resolve o toplevel e o
diretório comum, então symlinks e worktrees levam a uma única chave, e a
semântica de caminhos do runtime ignora maiúsculas e minúsculas onde o sistema
de arquivos dele faz isso; uma string de workdir armazenada nunca decide. Nenhum
caminho cruza o socket. O hub entrega a chave aos clientes como `repoKey` em
`GET /git/state` e em cada resumo em lote; o cliente nunca a deriva. Quando a
chave não pode ser resolvida, o campo fica ausente e o cliente mantém apenas o
tópico por chat.

O tópico não exige verificação de ownership: a chave não nomeia nada que o
usuário possa enumerar, e um frame de repositório é publicado no bus sob o id do
usuário dono da escrita, então um socket recebe frames de repositório apenas
dos repositórios da própria conta. Assinar uma chave que não corresponde a
nenhum deles é um tópico que nunca dispara. Uma chave malformada retorna
`UNSUPPORTED`, assim como um hub anterior ao tópico, e por isso o cliente deve
continuar funcionando com `git:<chatId>` quando uma assinatura `repo:` é
recusada.

Tópicos Git de outro usuário permanecem sem assinatura e retornam a mesma
resposta `NOT_FOUND`, sem enumeração, de um tópico indisponível. Gramáticas de
tópico desconhecidas retornam `UNSUPPORTED`.

### Identidade do escritor

A entrega é por usuário, então uma aba recebe a invalidation causada pela
própria escrita junto com as de todas as outras abas. Para dados otimistas esse
eco não é inofensivo: um auto-save com debounce pode receber o eco do servidor
enquanto o usuário ainda edita o mesmo controle, e refazer a leitura nesse
momento substitui o que ele está digitando.

Por isso uma invalidation de `settings` carrega um `writerId` opcional. Cada
aba do navegador escolhe um id por carregamento de página
(`apps/frontend/src/lib/realtime/writer-id.ts`) e o envia no header
`x-mangostudio-writer-id` nas escritas de app-settings; a API o copia para o
evento (`publishSettingsInvalidation`). A aba ignora a seção `app` de um evento
que traz o próprio id e aplica qualquer outro evento na hora. O id é gerado pela
aba, e não emitido no subscribe, para que uma escrita feita antes do ack do
socket, ou durante uma reconexão, ainda seja reconhecida.

O campo é um token de correlação, não uma identidade: o hub só o repassa aos
sockets do mesmo usuário e não confia nele para mais nada. Um id que não passa
em `RealtimeWriterIdSchema` é removido do evento em vez de fazer a escrita
falhar. Um evento sem `writerId` — invalidation originada no hub, como a
detecção da biblioteca concluindo, escrita por API key, ou um hub anterior ao
campo — é tratado como de outra aba, então a aba refaz a leitura. Isso custa no
máximo uma leitura redundante e nunca uma visão desatualizada. Só o tópico
`settings` carrega o campo; `chats` e `activity` não têm supressão a substituir.

O header também consta na lista de request headers do CORS, então vira uma regra
de ordem de deploy em uma implantação dividida (bundle em outra origem, veja
[Serving the bundle from another origin](../../architecture/frontend-build.md#serving-the-bundle-from-another-origin)):
**atualize a API antes do bundle.** Um bundle novo envia `x-mangostudio-writer-id`
em toda escrita de app-settings, e uma API anterior ao campo não o lista em
`Access-Control-Allow-Headers`, então o navegador falha o preflight e o save é
recusado. O binário na mesma origem entrega os dois juntos e não é afetado. O
header não é condicionado à capacidade do hub: a aba só descobre o que o hub
suporta depois que o socket confirma um subscribe, e uma escrita feita antes disso
sairia sem a condição.

## Limites E Códigos De Fechamento

O servidor Elysia raiz aplica limites de transporte a todas as rotas WebSocket:

| Limite                  | Valor  |
| ----------------------- | ------ |
| Timeout por inatividade | 60 s   |
| Payload máximo          | 16 KiB |
| Buffer de backpressure  | 64 KiB |
| Ação por backpressure   | Fechar |

A rota realtime também permite no máximo 8 conexões por usuário, 20 mensagens
de aplicação por segundo em cada socket, 20 mensagens de aplicação pendentes
por socket e 64 tópicos ativos por socket. A contagem de taxa acontece na
admissão, antes de a mensagem entrar na fila serializada, para que autorização
lenta de subscribe não reinicie a janela de taxa nem retenha trabalho
ilimitado. Uma operação de subscribe que ultrapassaria 64 tópicos é rejeitada
atomicamente. O limite de mensagens pendentes limita mensagens do cliente
aguardando esse handler, não frames brutos de transporte WebSocket.

| Código | Significado                                   |
| ------ | --------------------------------------------- |
| `4400` | Mensagens inválidas repetidas do cliente      |
| `4401` | Autenticação ausente ou não permitida         |
| `4403` | Origin de navegador não permitida             |
| `4429` | Limite de conexões, taxa ou fila de mensagens |
| `1011` | Falha inesperada no servidor                  |

Ultrapassar o limite de tópicos ativos retorna `RATE_LIMITED` sem fechar o
socket. Limites de conexão, de taxa de mensagens e de fila de mensagens
pendentes fecham com `4429`.

## Degradação E Recuperação

Eventos publicados enquanto um socket está desconectado são perdidos por
design. Ao conectar ou reconectar, o cliente deve considerar o cache
potencialmente desatualizado e atualizar as queries HTTP relevantes depois de
receber `ready`. Depois de assinar tópicos adicionais, atualize de novo após
`subscribed`. Reconexões devem usar backoff limitado e parar em `4401`.

Uma limitação conhecida: depois de o notebook acordar, um socket parado em um
backoff de 30 s não é encurtado por `online` nem por `visibilitychange`. O
`refetchOnReconnect` do TanStack Query já cobre a atualização nessa janela,
então reconectar alguns segundos depois não tem custo observável.

O bus alcança apenas sockets no processo atual da API. Deployments com vários
workers da API exigem uma camada externa de fan-out antes de prometer entrega
entre workers. Até lá, realtime é uma otimização de atualização de cache, não
uma fronteira de consistência ou durabilidade.

## Cliente Do Navegador

A metade do navegador fica em `apps/frontend/src/lib/realtime/`:
`realtime-client.ts` cuida da conexão, `parse-server-message.ts` restringe os
frames recebidos e `use-realtime-invalidation.ts` é o ponto de entrada React.

Um único socket serve toda a aba. `getRealtimeClient()` o cria de forma
preguiçosa no primeiro subscribe, então uma aba que não monta nada nunca abre
conexão. Os tópicos têm contagem de referências: vários componentes podem manter
o mesmo tópico, e a assinatura no servidor só é removida quando o último deles é
liberado.

`useRealtimeInvalidation(topic, onSignal)` assina durante o ciclo de vida de um
componente e entrega cada sinal a um callback. Quem chama invalida com o próprio
query client, portanto o módulo não conhece query keys nem tópicos. Os dois
sinais são `{ type: 'invalidate', message }` e `{ type: 'subscribed' }`.

`subscribed` é a barreira de "considere desatualizado". Como eventos publicados
enquanto o socket estava fora são perdidos, uma confirmação — na primeira
conexão, na reconexão e em um re-subscribe idempotente — significa que qualquer
cache daquele tópico pode ser anterior à assinatura e deve ser atualizado. Não
existe um sinal separado de `ready`: todo tópico que pode receber uma
invalidation é confirmado, então isso só causaria uma segunda atualização.

Regras que o módulo garante:

| Regra                       | Comportamento                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Nenhum frame antes de ready | Os envios são limitados pela fase do protocolo, não por `readyState`, que também cobre OPEN antes de `ready`.               |
| Subscribes agrupados        | Adições no mesmo tick são agrupadas em um frame, fatiado em 32 tópicos.                                                     |
| Tópicos rejeitados          | Um tópico respondido com `error` em vez de confirmação é terminal naquele socket e só é tentado de novo na próxima conexão. |
| Linger                      | Perder o último listener inicia uma reconciliação única de ~5 s, então a repetição do StrictMode não custa frames.          |
| Heartbeat                   | Um timer em `REALTIME_IDLE_TIMEOUT_SECONDS / 2.5`; um pong perdido força a reconexão. Qualquer frame recebido prova vida.   |
| Backoff                     | 1 s→30 s com meio jitter, reiniciado só após 10 s de estabilidade comprovada, não em `ready`.                               |

O heartbeat é derivado do timeout de inatividade compartilhado, para que a
cadência do ping e a janela que ele precisa vencer não se desalinhem. Ele também
funciona como watchdog de liveness: é o que detecta um socket meio aberto depois
de o notebook dormir, caso em que `onclose` nunca dispara.

O backoff depende de estabilidade, não de `ready`, então um servidor que aceita a
conexão e depois a derruba — oito abas contra o limite de conexões por usuário —
continua escalando em vez de entrar em laço quente.

Política de códigos de fechamento:

| Código                     | Comportamento do cliente                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `4401`                     | Para em definitivo e volta ao fluxo de autenticação; o singleton da aba é descartado para a nova sessão abrir outro socket. |
| `4403`, `4400`             | Para em definitivo; reconectar repetiria a mesma rejeição.                                                                  |
| `4429`, `1011`, transporte | Reconecta com backoff; `4429` já começa no teto.                                                                            |

## Como Adicionar Um Tópico

Estenda o canal nesta ordem:

1. Adicione a gramática do tópico, os escopos, helpers e cobertura TypeBox em
   `apps/shared/src/realtime/`.
2. Defina a regra de autorização na rota. Todo tópico limitado a um recurso
   deve verificar ownership sem revelar a existência de um recurso de outro
   usuário.
3. Publique invalidações no fluxo de mutação da aplicação somente depois que a
   mutação for concluída com sucesso.
4. Adicione testes com servidor real para autorização, entrega ao mesmo
   usuário, isolamento entre usuários, unsubscribe e cleanup.
5. Mapeie a invalidação para a atualização de queries HTTP no frontend. Não
   adicione payloads de entidades à mensagem WebSocket.
6. Atualize este documento e seu espelho em inglês.

Watchers de filesystem e sincronização de entidades não pertencem a este canal.
Nem a E/S de terminal: sessões interativas usam uma rota própria,
`/api/terminal/:id`, com controle de fluxo por socket, porque as opções de
socket que este canal compartilha fecham a conexão sob backpressure em vez de
desacelerá-la (veja [terminal.md](../features/terminal.md)).
