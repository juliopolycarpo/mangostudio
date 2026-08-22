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
