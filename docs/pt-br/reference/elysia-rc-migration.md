# Migração para o Elysia 2 RC

> 🇺🇸 [English version](../../reference/elysia-rc-migration.md)

Revisado com base nas [notas da versão RC](https://next.elysiajs.com/blog/elysia-20-rc/),
na [base da versão beta](https://next.elysiajs.com/blog/elysia-20), na documentação oficial
atual e nos pacotes publicados em 21 de outubro de 2026. As versões dos plugins e o
patch do OpenAPI foram atualizados para RC.0 em 26 de outubro de 2026.

## Versões e compatibilidade

| Pacote            | Versão anterior | Tag escolhida | Versão fixada |
| ----------------- | --------------- | ------------- | ------------- |
| `elysia`          | `2.0.0-beta.29` | `rc`          | `2.0.0-rc.0`  |
| `@elysia/cors`    | `2.0.0-beta.2`  | `rc`          | `2.0.0-rc.0`  |
| `@elysia/openapi` | `2.0.0-beta.6`  | `rc`          | `2.0.0-rc.0`  |
| `@elysia/eden`    | `2.0.0-beta.6`  | `rc`          | `2.0.0-rc.0`  |

Os plugins agora usam suas versões RC junto com a RC do núcleo.
As versões ficam fixadas nos manifestos, em vez de usar tags cujo destino pode mudar.
Metadados do registro: [core](https://registry.npmjs.org/elysia),
[CORS](https://registry.npmjs.org/@elysia%2fcors),
[OpenAPI](https://registry.npmjs.org/@elysia%2fopenapi),
[Eden](https://registry.npmjs.org/@elysia%2feden).

A RC restaura os métodos de instância `onRequest`, `onBeforeHandle` e `onError`.
Ao renomeá-los, preserve a ordem dos hooks, os escopos e os handlers de erro específicos
por classe. `mapResponse` e `derive` mantêm seus nomes na API da RC publicada.
As opções declaradas diretamente nas rotas, como `error`, também mantêm seus nomes.

O patch do OpenAPI passa para a RC.0. Sem ele, a suíte de contratos da aplicação falha
tanto na documentação de strings binárias em multipart quanto na asserção de que os
marcadores internos dos schemas nunca aparecem no documento. Os testes existentes de
inventário de rotas, schemas de erro, IDs de operação, política de CORS e limites de
payload de WebSockets com servidor em escuta cobrem a aplicação integrada, além da
construção dos plugins.

## Oportunidades e limites mantidos

| Recurso                                                                           | Decisão para a aplicação e evidências necessárias                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Inferência de erros](https://next.elysiajs.com/patterns/error-handling/)         | Manter os retornos tipados de `status()` na autenticação, na limitação de requisições e nos handlers de erro. A RC melhora a inferência por hooks e macros. Trabalhos futuros nas rotas podem retornar erros esperados tipados para melhorar o Eden; erros arbitrários lançados, como `throwApiError`, continuam invisíveis à inferência do tipo de retorno.                                                         |
| [OpenAPI `fromTypes()`](https://next.elysiajs.com/patterns/openapi/)              | Pode documentar respostas de sucesso ou erro que hoje não aparecem. O recurso já existia antes da RC; os schemas de runtime têm precedência. Uma avaliação precisa de configuração na raiz do monorepo e das declarações geradas disponíveis nas distribuições em bundle ou binário. Preservar os contratos públicos definidos primeiro pelos schemas.                                                               |
| [Compressão](https://next.elysiajs.com/plugins/compress/)                         | Avaliar o novo plugin oficial com adesão explícita por rota (`default: false`) para respostas JSON grandes. Os arquivos do frontend já usam pré-compressão. Antes de habilitá-lo, verificar a exclusão de SSE, respostas já codificadas, intervalos de bytes, headers de cache e respostas que contêm segredos. Nenhum ganho de desempenho foi medido aqui.                                                          |
| [AOT durante o build](https://next.elysiajs.com/patterns/aot/)                    | Reavaliar apenas com medições controladas de inicialização, build, tamanho dos artefatos e memória. O AOT já existia na beta e executa a aplicação durante o build; comprovar a segurança da execução de ensaio, o registro idêntico e a inicialização do binário. As [medições históricas da beta.4 (em inglês)](../../reference/tooling.md#elysia-build-time-aot--evaluated-not-adopted) não são evidências da RC. |
| [SSE e generators](https://next.elysiajs.com/essential/handler/)                  | Manter `sseResponse`: o `sse()` nativo não fornece nossos comentários de heartbeat nem a tradução de `SSEErrorEvent`. O cancelamento de generators não interrompe operações arbitrárias em espera com `await`; manter a propagação explícita de aborto. Esses recursos são anteriores à RC.                                                                                                                          |
| [WebSockets](https://next.elysiajs.com/patterns/websocket/)                       | Manter o plugin de transporte existente e os limites compartilhados de payload. Os testes de realtime, pareamento de runtime, terminal, desconexão e servidor em escuta comprovam a compatibilidade. Schemas por mensagem e respostas com generators estão disponíveis para trabalhos futuros no protocolo; alterar o protocolo não é necessário aqui.                                                               |
| [Macros](https://next.elysiajs.com/patterns/macro/)                               | Tipos explícitos de macros podem ajudar futuras macros de autorização nas opções das rotas. Os plugins de autenticação nomeados já fornecem escopo e deduplicação; esta migração não exige convertê-los.                                                                                                                                                                                                             |
| [Extensões do Eden](https://next.elysiajs.com/eden/treaty/plugin/)                | Considerar extensões do cliente para verbos personalizados ou instrumentação de mutações. Os hooks de mutação excluem GETs e assinaturas, portanto manter o fetcher atual para a negociação de Accept e os redirecionamentos de 401 em todas as requisições.                                                                                                                                                         |
| [Descarte de recursos e `defer`](https://next.elysiajs.com/essential/life-cycle/) | A beta e a RC já permitem recursos descartáveis derivados e pertencentes à requisição. Bancos de dados compartilhados e sessões de runtime continuam sob responsabilidade do encerramento da aplicação. Nenhum recurso atual de requisição foi identificado para conversão.                                                                                                                                          |
| TypeBox e respostas compiladas                                                    | Manter a injeção de namespace para binários autônomos, o registro do detector de tipo de arquivo, os testes de validação antecipada ou pré-compilada e o codificador de respostas JSON compilado. A RC publicada ainda usa um limiar de 16 requisições para compilação sob demanda; a migração não elimina o motivo desse codificador.                                                                               |
| RFC 9457                                                                          | Manter o ponto existente de negociação: as rotas retornam `ApiErrorResponse`, e a negociação renderiza os detalhes do problema. O `problem()` nativo não substitui essa arquitetura. Os testes existentes de erros e falhas da especificação cobrem tanto as respostas negociadas quanto as respostas JSON comuns.                                                                                                   |
| Outros runtimes e validadores                                                     | Adaptadores Node, bibliotecas alternativas de schema e o servidor de desenvolvimento fullstack do framework não atendem a esta distribuição com Bun e TypeBox. O `t.Accelerate` para outras bibliotecas de schema não justifica substituir os schemas compartilhados.                                                                                                                                                |
| Melhorias de inicialização e memória no framework                                 | A RC pode trazer benefícios automáticos. As medições do framework não comprovam ganhos de desempenho na aplicação; validar o MangoStudio separadamente antes de afirmar qualquer economia.                                                                                                                                                                                                                           |

Os itens de acompanhamento são oportunidades de avaliação, não defeitos da aplicação
recém-descobertos nem recursos necessários para adotar a RC. Esta migração não os habilita
sem avaliação.
