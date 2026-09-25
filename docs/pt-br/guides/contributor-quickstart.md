# Início Rápido Para Contribuidores

Use este guia quando quiser o caminho mais curto entre o clone do repositório e uma alteração validada.

## 1. Configuração

Você precisa do [Bun](https://bun.sh/) e de um toolchain Rust instalado pelo
[rustup](https://rustup.rs/) (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`).
O hub inicia o Local como o binário `mangostudio-runtime` compilado pelo cargo, e o
`rust-toolchain.toml` fixa a versão que o rustup instala no primeiro build.

```bash
git clone <repo-url>
cd mangostudio
bun install
```

Configuração local opcional:

```bash
mkdir -p ~/.mango
cp .mango/config.toml.example ~/.mango/config.toml
cp .mango/.env.example ~/.mango/.env
```

## 2. Rodar A Aplicação

```bash
bun run dev
```

Ele executa `cargo build -p mangostudio-runtime` antes, para que o Local tenha um binário para
iniciar; defina `MANGOSTUDIO_RUNTIME_BINARY` para usar um que você já compilou. Os testes da API
que alcançam o Local precisam do mesmo binário.

URLs locais padrão:

- App e API: `http://localhost:3001`

Nada observa o frontend. Depois de editar um arquivo do frontend, reconstrua e atualize o
navegador — não há HMR, então a atualização é necessária de qualquer forma:

```bash
bun run --filter @mangostudio/frontend build
```

## 3. Saber Por Onde Começar

- Leia [`../../../AGENTS.md`](../../../AGENTS.md) para regras e roteamento do repositório.
- Use [`../reference/agent-playbooks.md`](../reference/agent-playbooks.md) quando precisar de um mapa de arquivos por feature.
- Use [`../reference/testing.md`](../reference/testing.md) antes de adicionar ou alterar comportamento.
- Use [`../architecture/overview.md`](../architecture/overview.md) para o layout dos workspaces e módulos.

## 4. Git Hooks

Um hook [lefthook](https://github.com/evilmartians/lefthook) de pre-commit é instalado automaticamente durante `bun install`. Ele executa estas verificações em cada commit:

| Verificação        | Gatilho      | Arquivos alvo               | Impede o commit em caso de            |
| ------------------ | ------------ | --------------------------- | ------------------------------------- |
| Biome formato/lint | `pre-commit` | `*.{ts,tsx,js,jsx,json}`    | Erros de formato ou lint              |
| dprint formato     | `pre-commit` | `*.{md,mdx,toml,yml,yaml}`  | Erros de formato                      |
| dprint Dockerfile  | `pre-commit` | `{Dockerfile,Dockerfile.*}` | Erros de formato                      |
| Typecheck afetados | `pre-commit` | Todos os arquivos staged    | Erros de tipo nos workspaces afetados |

Arquivos formatados são re-adicionados ao stage automaticamente. A verificação de typecheck é ignorada durante merge ou rebase.

## 5. Comandos Comuns

```bash
bun run check
bun run test
bun run verify   # gate CI local: check → test --coverage → build --all
bun run build
```

Lanes direcionadas:

```bash
bun run test --unit
bun run test --integration
bun run test:e2e:setup  # instala Chromium antes do primeiro e2e
bun run test --e2e
bun run check --staged    # apenas workspaces afetados pelos arquivos staged
bun run fix --staged      # correção automática apenas nos workspaces afetados
```

## 6. Fluxo Diário

1. Comece pela rota, componente, hook, serviço ou contrato mais próximo.
2. Expanda uma camada por vez em vez de ler o repositório inteiro.
3. Mantenha as alterações focadas em uma preocupação.
4. Rode `bun run check` após cada conjunto de mudanças.
5. Antes do handoff ou PR, rode `bun run verify` (ou `bun run check && bun run test` para uma passagem mais leve).

## 7. Documentos Relacionados

- [`../../../.github/CONTRIBUTING.md`](../../../.github/CONTRIBUTING.md) para política de contribuição e regras de commit
- [`../reference/api.md`](../reference/api.md) para o mapa de endpoints
- [`../operations/deployment.md`](../operations/deployment.md) para builds standalone
