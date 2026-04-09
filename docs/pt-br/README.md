<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# MangoStudio

Estúdio de geração de imagens e chat alimentado por IA com suporte a modelos Gemini, compatíveis com OpenAI e Anthropic.

> 🇺🇸 [Read in English](../../README.md)

## Pré-requisitos

- [Bun](https://bun.sh/) (v1.3.11+)
- Uma ou mais chaves de API para os provedores suportados (Gemini, compatíveis com OpenAI, Anthropic)

## Instalação

1. Clone o repositório:

   ```bash
   git clone <repo-url>
   cd mangostudio
   ```

2. Instale as dependências:

   ```bash
   bun install
   ```

3. Inicie os servidores de desenvolvimento:

   ```bash
   bun run dev
   ```

   Isso inicia:
   - **API** em `http://localhost:3001` (Elysia + Kysely/SQLite)
   - **Frontend** em `http://localhost:5173` (Vite + React)

## Configuração de Conectores (Secrets)

O MangoStudio possui um sistema flexível de múltiplos conectores que permite gerenciar várias chaves de API com diferentes níveis de persistência.

### Métodos de Persistência Suportados

1. **OS Secret Store** — Armazenamento nativo seguro do sistema operacional (via `Bun.secrets`). Recomendado para maior segurança.
2. **config.toml** — Armazena chaves em `~/.mango/config.toml`. Ideal para compartilhar chaves entre instâncias ou ferramentas CLI.
3. **Arquivo .env** — Adiciona variáveis ao arquivo `.mango/.env`.

### Como Configurar

Acesse a página **Configurações** na interface do MangoStudio para adicionar e gerenciar conectores.

Para cada conector, é possível habilitar ou desabilitar modelos específicos (ex: Gemini 2.5 Flash, Gemini 2.0 Flash Image). O MangoStudio seleciona automaticamente o conector correto com base no modelo ativo no chat.

### Sincronização via Terminal

Você pode adicionar chaves manualmente em `~/.mango/config.toml`:

```toml
[gemini_api_keys]
pessoal = "sua-chave-aqui"
trabalho = "outra-chave-aqui"
```

O MangoStudio sincroniza essas chaves automaticamente ao carregar a página de Configurações ou ao iniciar uma geração.

## Estrutura do Projeto

```
mangostudio/
├── .mango/            # Exemplo de configuração
│   └── config.toml.example
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── routes/        # Endpoints Elysia (chats, messages, settings, auth…)
│   │       ├── services/      # Lógica de negócio (gemini, secret-store)
│   │       ├── plugins/       # Middlewares reutilizáveis (auth, rate-limit)
│   │       └── db/            # Kysely + SQLite + migrações
│   ├── frontend/
│   │   └── src/
│   │       ├── components/
│   │       │   └── ui/        # Design system (Button, Input, Card, Spinner, Toast)
│   │       ├── features/      # Módulos de feature (chat, gallery…)
│   │       ├── hooks/         # React hooks (use-i18n, use-app-state…)
│   │       └── routes/        # Páginas TanStack Router
│   └── shared/
│       └── src/
│           ├── contracts/     # DTOs de request/response
│           ├── types/         # Tipos de domínio
│           ├── i18n/          # Dicionários pt-BR / en + hook useI18n
│           └── test-utils/    # Mock factories compartilhadas
├── docs/
│   ├── pt-br/
│   │   └── README.md          # Esta documentação
│   └── TESTING.md             # Estratégia e guia de testes
├── package.json               # Raiz do Bun workspace
└── tsconfig.json              # Configuração base de TypeScript
```

## Scripts Principais

| Comando                  | Descrição                                          |
| ------------------------ | -------------------------------------------------- |
| `bun install`            | Instala todas as dependências do workspace         |
| `bun run dev`            | Inicia todos os servidores de dev simultaneamente  |
| `bun run dev --api`      | Inicia apenas o servidor de dev da API             |
| `bun run build`          | Build do frontend para produção                    |
| `bun run build --binary` | Gera binários standalone com frontend embutido     |
| `bun run check`          | Executa ESLint, Prettier check e typecheck         |
| `bun run test`           | Executa as lanes unit e integration                |
| `bun run test --unit`    | Executa apenas as suítes unitárias                 |
| `bun run test --e2e`     | Executa a suíte end-to-end com Playwright (opt-in) |
| `bun run fix`            | Aplica ESLint --fix e depois Prettier --write      |

## Arquitetura

| Camada       | Tecnologias                                               |
| ------------ | --------------------------------------------------------- |
| **Frontend** | React 19, Vite 8, Tailwind CSS v4, TanStack Router/Query  |
| **API**      | Elysia, Better Auth, rate limiting nativo                 |
| **Banco**    | SQLite via Kysely (query builder type-safe)               |
| **IA**       | Multi-provedor (Gemini, compatível com OpenAI, Anthropic) |
| **Runtime**  | Bun — sem dependência de Node.js                          |
| **i18n**     | Dicionário TypeScript puro em `@mangostudio/shared/i18n`  |

## Design System

O frontend usa um design system próprio em `apps/frontend/src/components/ui/`:

- **`Button`** — variantes `primary`, `secondary`, `ghost`; prop `loading`
- **`Input`** — label, mensagem de erro, spread de `InputHTMLAttributes`
- **`Card`** — variantes `glass` (glassmorphism) e `solid`
- **`Spinner`** — indicador de carregamento com tamanhos `sm`, `md`, `lg`
- **`Toast`** — notificações não-bloqueantes via hook `useToast()`

## Internacionalização (i18n)

Strings de UI centralizadas em `@mangostudio/shared/i18n`. Suporte a pt-BR (padrão) e en, com detecção automática via `navigator.language`.

```tsx
import { useI18n } from '@/hooks/use-i18n';

function MyComponent() {
  const { t } = useI18n();
  return <h1>{t.auth.loginTitle}</h1>;
}
```

O tipo `Messages` é inferido diretamente do dicionário `pt-BR.ts` (`as const`). Adicionar uma chave sem traduzir em `en.ts` gera erro de compilação imediatamente.

## Notas de Build Standalone

O comando `bun run build --binary` compila a API em binários específicos por plataforma em `out/<platform>/`.

- O banco de dados é persistido em `~/.mangostudio/database.sqlite` por padrão.
- Os assets do frontend são servidos a partir do diretório `public/` vizinho ao executável.

## Licença

Este projeto está licenciado sob a [Licença MIT](../../LICENSE).
