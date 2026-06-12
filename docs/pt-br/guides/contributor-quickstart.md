# Início Rápido Para Contribuidores

Use este guia quando quiser o caminho mais curto entre o clone do repositório e uma alteração validada.

## 1. Configuração

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

URLs locais padrão:

- Frontend: `http://localhost:5173`
- API: `http://localhost:3001`

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
5. Antes do handoff ou PR, rode `bun run check && bun run test`.

## 7. Documentos Relacionados

- [`../../../.github/CONTRIBUTING.md`](../../../.github/CONTRIBUTING.md) para política de contribuição e regras de commit
- [`../reference/api.md`](../reference/api.md) para o mapa de endpoints
- [`../operations/deployment.md`](../operations/deployment.md) para builds standalone
