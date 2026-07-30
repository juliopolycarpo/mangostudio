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
| `settings`     | Qualquer sessão autenticada por cookie | `app`, `provider`, `tool`                                               |
| `git:<chatId>` | O usuário deve ser dono de `<chatId>`  | `state`, `stashes`, `branches`, `history`, `commits`, `diffs`, `github` |

Tópicos Git de outro usuário permanecem sem assinatura e retornam a mesma
resposta `NOT_FOUND`, sem enumeração, de um tópico indisponível. Gramáticas de
tópico desconhecidas retornam `UNSUPPORTED`.

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

| Código                     | Comportamento do cliente                                   |
| -------------------------- | ---------------------------------------------------------- |
| `4401`                     | Para em definitivo e volta ao fluxo de autenticação.       |
| `4403`, `4400`             | Para em definitivo; reconectar repetiria a mesma rejeição. |
| `4429`, `1011`, transporte | Reconecta com backoff; `4429` já começa no teto.           |

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
