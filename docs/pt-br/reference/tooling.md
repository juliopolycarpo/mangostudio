# Ferramentas

> 🇺🇸 [English version](../../reference/tooling.md)

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

| Task               | Cache | Outputs / Env                                      | Notas                                       |
| ------------------ | ----- | -------------------------------------------------- | ------------------------------------------- |
| `dev`              | off   | —                                                  | Persistente — roda servidores de dev        |
| `build`            | on    | `dist/**`; env `VITE_*`                            | Depende de `^build` upstream                |
| `check:quick`      | on    | —                                                  | Lint / format; inputs em `biome.json`       |
| `typecheck`        | on    | —                                                  | Inputs em `tsconfig.json` raiz              |
| `circular`         | on    | —                                                  | Detecção de dependências circulares         |
| `test:unit`        | on    | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`         | Testes unitários                            |
| `test:integration` | off   | env `DATABASE_PATH`, `CI`, `MANGOSTUDIO_*`         | Testes de integração (sempre reexecutados)  |
| `test:coverage`    | off   | `$TURBO_ROOT$/.mango/artifacts/coverage/**`; env ↑ | Relatórios de cobertura                     |
| `//#test:scripts`  | on    | inputs `scripts/**`                                | Testes de scripts na raiz (cache via turbo) |

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
