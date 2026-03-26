# Contribuindo com o MangoStudio

Obrigado pelo seu interesse em contribuir com o MangoStudio!

> 🇺🇸 [Read in English](../../CONTRIBUTING.md)

## Pré-requisitos

- [Bun](https://bun.sh/) v1.3.11 ou superior
- Git com assinatura GPG configurada (veja [Diretrizes de Commit](#diretrizes-de-commit))

## Configuração do Ambiente

```bash
# Clone o repositório
git clone <repo-url>
cd mangostudio

# Instale todas as dependências do workspace
bun install

# Copie e configure as variáveis de ambiente
cp apps/api/.env.example apps/api/.env.local
# Edite apps/api/.env.local e defina GEMINI_API_KEY
```

## Fluxo de Desenvolvimento

```bash
# Inicia todos os servidores de dev (API em :3001, frontend em :5173)
bun run dev

# Ou inicie cada workspace individualmente
bun run dev:api
bun run dev:frontend
```

## Padrões de Código

Consulte [`AGENTS.md`](../../AGENTS.md) para o guia completo de estilo, convenções de nomes, regras de i18n e diretrizes de testes. Pontos principais:

- TypeScript em todo o projeto — nenhum arquivo `.js` puro
- Indentação de 2 espaços, aspas simples, ponto e vírgula
- Todas as strings visíveis ao usuário devem vir de `@mangostudio/shared/i18n` — nunca codifique texto diretamente
- Hooks que contêm JSX devem usar a extensão `.tsx`
- Arquivos `CLAUDE.md` e `GEMINI.md` com `@imports`
- Agentes de IA: use [`AGENTS.md`](../../AGENTS.md) como fonte de orientações agnósticas

## Executando os Testes

```bash
# Todas as suítes
bun run test

# Apenas unitários
bun run test:unit

# Apenas integração
bun run test:integration

# Cobertura do frontend
bun run test:coverage

# Pipeline CI completo (lint + test + coverage)
bun run test:ci
```

## Linting e Verificação de Tipos

```bash
bun run lint
```

Executa a verificação de tipos TypeScript e ESLint em todos os workspaces.

## Build

```bash
bun run build
```

Gera o build do frontend com Vite. Verifique se não há erros de TypeScript antes de abrir um PR.

## Diretrizes de Commit

Este projeto usa [Conventional Commits](https://www.conventionalcommits.org/). Todo commit deve ser assinado com GPG e incluir um sign-off:

```bash
git commit -S -s -m "feat(scope): resumo imperativo curto"
```

Tipos comuns: `feat`, `fix`, `chore`, `test`, `docs`, `refactor`, `ci`.

Mantenha cada commit com escopo único. Prefira vários commits pequenos a um único commit grande.

**Todas as mensagens de commit devem ser escritas em inglês.**

## Template de Mensagem de Commit

Configure o Git para pré-preencher o editor de commit com o template do projeto:

```bash
git config commit.template .gitmessage
```

Esta é uma configuração local única. O template está em `.gitmessage` na raiz do repositório.

## Processo de Pull Request

1. Crie um branch a partir de `main` com um nome descritivo (ex: `feat/add-gallery-empty-state`).
2. Execute a suíte de validação completa localmente antes de fazer push:
   ```bash
   bun run lint && bun run test && bun run build
   ```
3. Abra um PR contra `main` e preencha o template de PR.
4. PRs exigem que todas as verificações de CI passem antes do merge.
5. Screenshots ou GIFs são obrigatórios para mudanças de UI.

## Migrações de Banco de Dados

```bash
bun run migrate
```

Se sua mudança exigir uma migração de schema, adicione o arquivo de migração em `apps/api/src/db/migrations/` e execute o comando acima localmente para verificar que ele é aplicado corretamente.

## Segurança

Nunca faça commit de arquivos `.env` populados ou chaves de API. O `GEMINI_API_KEY` é acessado apenas no lado do servidor e não deve ser exposto ao bundle do frontend.

Se você descobrir uma vulnerabilidade de segurança, por favor reporte-a de forma privada em vez de abrir uma issue pública.
