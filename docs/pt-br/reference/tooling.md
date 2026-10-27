# Ferramentas

> 🇺🇸 [English version](../../reference/tooling.md)

## Bun

A versão instalada vem do canal `canary` em [`.bun-version`](../../../.bun-version).
Instale com `bun upgrade --canary`. O campo `packageManager` registra uma versão
estável para o Turborepo, que não aceita `bun@canary`. As chaves de cache usam
`bun --revision` e o manifesto de distribuição registra a revisão e a origem dos
runtimes por plataforma. A seção [Bun em inglês](../../reference/tooling.md#bun)
explica a verificação de downloads no CI.

## Verificação de tipos

O script `typecheck` de cada workspace executa o verificador nativo
`bun check --no-script`. O projeto de scripts da raiz é verificado separadamente
com `-p scripts/tsconfig.json`. A flag `--no-script` seleciona o verificador
nativo, pois os manifests da raiz e dos workspaces também definem um script
`check`. Use `bun run check` para executar todas as verificações do repositório;
`bun check` executa esse script quando ele existe.

O Turbo inicia os typechecks em paralelo. Cada verificação lê as fontes e não
produz saída, então não precisa esperar pelo workspace upstream. A task sem
script `transit` inclui as fontes upstream na chave de cache. O verificador do
Bun segue a semântica do TypeScript 7; o pacote `typescript` fixado continua
instalado para editores e ferramentas que geram declarações.

Não use `with` para selecionar typechecks upstream: o Turbo encerra uma task `with` quando a
task que a lista termina, podendo perder um erro de tipo mais lento. `typecheck:with-deps`
seleciona esses workspaces sem esse limite de duração.

Por padrão, o Bun usa uma thread por núcleo de CPU. A opção `--threads` limita
esse número em máquinas com recursos restritos.

### API de compatibilidade

O TS 7.0 não expõe uma API programática estável. Os scripts de cobertura do
QA-gate (`scripts/qa-gate/source-*-coverage.ts`) importam a API do compilador
de `@typescript/typescript6` (fixado em `6.0.2`), o pacote oficial de
compatibilidade side-by-side. Quando o TS 7.1 lançar uma nova API, a dependência
de compatibilidade pode ser removida.

## Turborepo

Este monorepo usa [Turborepo](https://turborepo.dev) **2.x** estável, com versão exata
fixada no [`package.json`](../../../package.json) raiz, como camada compartilhada de build system. O Turborepo orquestra a
execução de tasks entre workspaces e fornece cache endereçável por conteúdo.

### Política

- **Apenas 2.x estável.** A versão fixada no `package.json` raiz é a fonte da
  verdade. Sem builds canary, sem ranges flutuantes.
- **Sem Remote Cache ainda.** Apenas cache local até o modelo de tasks estar
  consolidado.
- **Wrappers Bun na raiz são a interface pública.** `bun run dev`, `bun run build`,
  `bun run check` e `bun run test` permanecem os comandos canônicos.

### Tasks atuais

[`turbo.jsonc`](../../../turbo.jsonc) define o grafo e os inputs de cada task:

| Task                      | Cache | Outputs / Env                                                                                               | Notas                                                                                                                           |
| ------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `dev`                     | off   | —                                                                                                           | Persistente — roda servidores de dev                                                                                            |
| `build`                   | on    | `dist/**`                                                                                                   | Depende de `^build`; `apps/frontend` sobrescreve `env` para `MANGO_API_URL`, `VITE_*` e inclui `dist-metafile.json` nos outputs |
| `check:quick`             | on    | —                                                                                                           | Bun lint / formato; inclui configurações da raiz e fontes upstream via `transit` na chave                                       |
| `check:cycles`            | off   | —                                                                                                           | Ciclos TS/JS, incluindo arquivos gerados e ignorados ausentes dos inputs de cache do VCS                                        |
| `transit`                 | —     | —                                                                                                           | Sem script; inclui fontes upstream na chave sem ordenar sua execução; opt-in com `dependsOn: ["transit"]`                       |
| `typecheck`               | on    | —                                                                                                           | Inclui `tsconfig.json` raiz e depende de `transit`; workspaces verificam tipos em paralelo                                      |
| `typecheck:with-deps`     | —     | —                                                                                                           | Sem script; seleciona `typecheck` do workspace e de suas dependências; usado por `bun run check`                                |
| `test:unit`               | on    | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`                                                                  | Depende de `transit`; editar uma dependência importada invalida o cache                                                         |
| `test:integration`        | off   | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`                                                                  | Testes de integração, sempre reexecutados                                                                                       |
| `test:coverage`           | off   | `$TURBO_ROOT$/.mango/artifacts/coverage/**`; env ↑                                                          | Relatórios de cobertura, sempre reexecutados                                                                                    |
| `//#test:scripts`         | on    | inputs `$TURBO_DEFAULT$`, `scripts/**`; output `.mango/artifacts/junit/root.xml`; env `CI`, `MANGOSTUDIO_*` | Testes da raiz usados pela cobertura e pelos shards de CI; restaura a evidência JUnit em um hit                                 |
| `//#test:scripts:workers` | on    | inputs `$TURBO_DEFAULT$`, `scripts/**`; env `CI`, `MANGOSTUDIO_*`                                           | Testes da raiz divididos em processos de workers na fase unit comum; sem relatório restaurado do cache                          |

### Cache local e em CI

O cache local fica em `.turbo/cache` e é ignorado pelo Git. Worktrees compartilham por padrão
o cache do checkout principal; defina `TURBO_CACHE_DIR=.turbo/cache` para um cache próprio.

O CI persiste o cache local pelo composite compartilhado `cache-scoped`. Check, test e build
mantêm escopos separados de validade e escrita. Um run bem-sucedido salva um snapshot
rotacionado apenas quando o Turbo cria novos payloads `*.tar.zst`; ID e tentativa do run
distinguem cada save. Um run que só usa hits não salva nada. PRs restauram seus snapshots
anteriores e entradas confiáveis de `main`; `main` nunca restaura o cache de um PR.

`CI_CACHE_EPOCH` é a variável de invalidação emergencial do repositório, com fallback `v1`.
A [política de cache de CI em inglês](../../reference/testing.md#ci-cache-policy) mantém as
chaves, a ordem de restauração, a retenção e os invalidadores completos.

A lane check não tem cache separado de build-info TypeScript: `bun check` não
gera build-info, e `incremental` está desativado em todos os tsconfigs. O Turbo é o único cache de typecheck. O teste
`scripts/tests/typescript-incremental.unit.test.ts` fixa esse contrato.

### Trabalho futuro

- Remote Cache para CI.
- Filtragem `--affected` nos pipelines de CI.
- Configuração Turbo por pacote quando o grafo base estiver estável.

## Orçamentos de inicialização do runtime

O hub mantém três relógios separados para um runtime: **provisionamento** (baixar imagem ou
release, instalar no WSL), **handshake** (do processo iniciado até o `hello`) e **liveness**
(ping periódico numa conexão já aberta). O orçamento de handshake de um filho local é 5s, ou
30s num hub Windows; os transportes remotos (ssh, container, http) recebem pelo menos o mesmo
que um filho local. Os detalhes e as medições num desktop estão na versão em inglês desta
página (`docs/reference/tooling.md`, "Runtime startup budgets").

`scripts/bench/runtime-handshake.ts` inicia o runtime por stdio como o hub faz e mede cada
fase. Uma execução manual pontual do smoke, num branch de medição, rodou o script contra o
runtime de release que cada job binário preparou nos runners hospedados do GitHub. Execução
[36219246581](https://github.com/juliopolycarpo/mangostudio/actions/runs/36219246581), código
`46558e95` (perfil de release com LTO fat), 2026-09-26, Bun 1.4.2, em milissegundos como mín /
mediana / p95 / máx:

| Runner        | CPU                                         | Cache         | Execuções | spawn (ms)                    | spawn → hello (ms)                | início → primeira requisição (ms) |
| ------------- | ------------------------------------------- | ------------- | --------: | ----------------------------- | --------------------------------- | --------------------------------- |
| darwin-arm64  | Apple M1 (Virtual) x3                       | mesmo arquivo |        20 | 0.7 / 0.8 / 1.9 / 6.4         | 598.7 / 667.5 / 777.7 / 795.8     | 601.3 / 671.8 / 779.2 / 798.4     |
| darwin-arm64  | Apple M1 (Virtual) x3                       | cópia nova    |        10 | 0.8 / 0.9 / 8.3 / 8.3         | 615.9 / 626.3 / 702 / 702         | 618.2 / 629.1 / 712.4 / 712.4     |
| darwin-x64    | Intel(R) Core(TM) i7-8700B CPU @ 3.20GHz x4 | mesmo arquivo |        20 | 2.1 / 2.4 / 3.7 / 17          | 1209.4 / 1387.1 / 1838.6 / 1994.6 | 1213.2 / 1391.4 / 1844.1 / 1999.9 |
| darwin-x64    | Intel(R) Core(TM) i7-8700B CPU @ 3.20GHz x4 | cópia nova    |        10 | 1.4 / 1.6 / 11.8 / 11.8       | 1218.6 / 1287 / 1548.9 / 1548.9   | 1222.6 / 1294.3 / 1553.2 / 1553.2 |
| linux-arm64   | unknown x4                                  | mesmo arquivo |        20 | 0.6 / 0.7 / 0.8 / 8.7         | 70.5 / 73.4 / 75.9 / 76.5         | 73.5 / 75.3 / 78.7 / 81.1         |
| linux-arm64   | unknown x4                                  | cópia nova    |        10 | 0.7 / 0.7 / 9 / 9             | 69.9 / 73.5 / 74.8 / 74.8         | 74.7 / 75.5 / 80.9 / 80.9         |
| linux-x64     | AMD EPYC 7763 64-Core Processor x4          | mesmo arquivo |        20 | 0.6 / 0.7 / 1 / 10.2          | 75.2 / 79.9 / 83.5 / 83.5         | 80 / 82 / 86.2 / 87.3             |
| linux-x64     | AMD EPYC 7763 64-Core Processor x4          | cópia nova    |        10 | 0.6 / 0.7 / 11.2 / 11.2       | 73.8 / 80.6 / 82.9 / 82.9         | 81.5 / 82.8 / 86.8 / 86.8         |
| windows-arm64 | Cobalt 100 x4                               | mesmo arquivo |        20 | 3 / 3.2 / 3.6 / 17.7          | 142.9 / 159.3 / 431 / 2064.1      | 151.5 / 168 / 439.6 / 3218.2      |
| windows-arm64 | Cobalt 100 x4                               | cópia nova    |        10 | 162.9 / 251.6 / 488.7 / 488.7 | 144 / 157.1 / 171.6 / 171.6       | 332.8 / 412.3 / 652.7 / 652.7     |
| windows-x64   | AMD EPYC 7763 64-Core Processor x4          | mesmo arquivo |        20 | 2.6 / 2.9 / 3.9 / 19.3        | 137 / 163.8 / 2127.6 / 2299.1     | 144.7 / 171.8 / 4151.4 / 4361.5   |
| windows-x64   | AMD EPYC 7763 64-Core Processor x4          | cópia nova    |        10 | 115.2 / 121.9 / 145.3 / 145.3 | 135.9 / 153.5 / 165.6 / 165.6     | 268.4 / 280.9 / 304.2 / 304.2     |

- **Todos os runners cabem no orçamento.** O handshake mais lento é o macOS x64 (mediana
  1,39s, máximo 2,0s) contra 5s; o Windows chega a 2,3s numa primeira execução, contra 30s.
- **No macOS o runtime leva ~0,6–1,4s antes do `hello` (Intel, mediana ~1,4s); no Linux, ~80ms.** O spawn em si fica
  abaixo de 3ms nos dois; o tempo é o runtime montando o manifesto de capacidades (shells, Git,
  `gh`) antes de cumprimentar.
- **No Windows, as primeiras execuções de um binário são os pontos fora da curva** (2,1s até o
  `hello` no `windows-x64`), depois 140–230ms.
