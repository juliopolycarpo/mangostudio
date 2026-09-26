# Ferramentas

> 🇺🇸 [English version](../../reference/tooling.md)

## TypeScript 7

O monorepo verifica tipos com [TypeScript 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/),
o port nativo em Go. O TS 7 traz um único binário `tsc` que paraleliza parsing,
type-checking e emit entre núcleos, tipicamente 8–12x mais rápido que o TS 6 em
builds completos.

### Type-checking

Cada workspace executa `tsc --noEmit` (fixado em `7.0.2`) via seu script
`typecheck`. O Turbo orquestra esses scripts entre workspaces em paralelo, e
cada invocação do `tsc` paraleliza internamente — as duas camadas compõem sem
conflito.

### Ajuste de paralelismo

O TS 7 expõe flags experimentais para ajustar o paralelismo:

| Flag               | Padrão | Finalidade                                                                                                                 |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `--checkers N`     | 4      | Número de workers de type-checker. Aumente em máquinas com mais núcleos; defina como 1 em runners de CI com pouca memória. |
| `--builders N`     | 1      | Builders de project-references paralelos sob `--build`. Não usado aqui — o Turbo cuida da orquestração entre workspaces.   |
| `--singleThreaded` | off    | Desabilita todo o paralelismo. Útil para depurar diagnósticos dependentes de ordem.                                        |

Os padrões são mantidos; o monorepo é pequeno o suficiente para que
`--checkers 4` seja o ponto ideal. Se os runners de CI ficarem com pouca
memória, defina `--checkers 2` ou `--checkers 1` nos scripts de `typecheck`
dos workspaces.

### API de compatibilidade

O TS 7.0 não expõe uma API programática estável. Os scripts de cobertura do
QA-gate (`scripts/qa-gate/source-*-coverage.ts`) importam a API do compilador
de `@typescript/typescript6` (fixado em `6.0.2`), o pacote oficial de
compatibilidade side-by-side. Quando o TS 7.1 lançar uma nova API, a dependência
de compatibilidade pode ser removida.

## Turborepo

Este monorepo usa [Turborepo](https://turborepo.dev) **2.x** (atualmente
`2.9.16`) como camada compartilhada de build system. O Turborepo orquestra a
execução de tasks entre workspaces e fornece cache endereçável por conteúdo.

### Política

- **Apenas 2.x estável.** A versão fixada no `package.json` raiz é a fonte da
  verdade. Sem builds canary, sem ranges flutuantes.
- **Sem Remote Cache ainda.** Apenas cache local até o modelo de tasks estar
  consolidado.
- **Wrappers Bun na raiz são a interface pública.** `bun run dev`, `bun run build`,
  `bun run check` e `bun run test` permanecem os comandos canônicos.

### Tasks atuais

| Task               | Cache | Outputs / Env                                      | Notas                                                                                                                                      |
| ------------------ | ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `dev`              | off   | —                                                  | Persistente — roda servidores de dev                                                                                                       |
| `build`            | on    | `dist/**`                                          | Depende de `^build` upstream; `apps/frontend` sobrescreve `env` para `MANGO_API_URL`, `VITE_*` e adiciona `dist-metafile.json` a `outputs` |
| `check:quick`      | on    | —                                                  | Lint / format; inputs em `biome.json`                                                                                                      |
| `typecheck`        | on    | —                                                  | Inputs em `tsconfig.json` raiz                                                                                                             |
| `circular`         | on    | —                                                  | Detecção de dependências circulares                                                                                                        |
| `test:unit`        | on    | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`         | Testes unitários                                                                                                                           |
| `test:integration` | off   | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`         | Testes de integração (sempre reexecutados)                                                                                                 |
| `test:coverage`    | off   | `$TURBO_ROOT$/.mango/artifacts/coverage/**`; env ↑ | Relatórios de cobertura                                                                                                                    |
| `//#test:scripts`  | on    | inputs `$TURBO_DEFAULT$`, `scripts/**`             | Testes de scripts na raiz (cache via turbo)                                                                                                |

### Cache em CI

O CI persiste o cache local do Turbo com `actions/cache` nas lanes check, test e
build. Cada lane usa um prefixo de chave separado:

```text
${{ runner.os }}-${{ env.CACHE_VERSION }}-turbo-<lane>-${{ github.sha }}
```

O sufixo `github.sha` salva um cache novo a cada execução bem-sucedida, enquanto
o prefixo de restore traz o cache mais recente da lane. Incrementar
`CACHE_VERSION` invalida todos os caches de CI quando necessário.

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
- **No macOS o runtime leva ~0,6–1,3s antes do `hello`; no Linux, ~80ms.** O spawn em si fica
  abaixo de 3ms nos dois; o tempo é o runtime montando o manifesto de capacidades (shells, Git,
  `gh`) antes de cumprimentar.
- **No Windows, as primeiras execuções de um binário são os pontos fora da curva** (2,1s até o
  `hello` no `windows-x64`), depois 140–230ms.
