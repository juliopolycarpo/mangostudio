# Labels de Classificação

Todo pull request precisa carregar pelo menos uma label `area:` ou `type:`, e toda issue deve
carregar exatamente uma label `type:` mais uma label `status:`. Esta página é a taxonomia
completa por trás dessas regras.

## O que é aplicado por quem

`.github/labeler.yml` mapeia globs de arquivos alterados para labels, e o gate "Verify
classification labels" (`.github/workflows/labeler.yml`) falha um PR que termine sem nenhuma
label `area:` ou `type:`. Esse gate é um check obrigatório em `main` — veja [`ci.md`](./ci.md).

A atribuição de PRs é separada: o workflow `auto-assign.yml` atribui o autor e solicita review
de quem já commitou nos arquivos alterados pelo PR (histórico da branch base), então ele não
precisa de configuração de dono por label.

Em issues, labels `area:` são opcionais, mas encorajadas quando a área afetada é clara — elas
carregam o mesmo sinal de roteamento que em PRs. O workflow `issue-triage.yml` aplica a parte
`type:`/`status:`: adiciona `status: needs triage` na abertura quando nenhuma label `status:`
está presente, e aplica `status: needs author` mais um comentário único quando uma issue
**aberta** tem zero ou várias labels `type:`. Issues fechadas são deixadas em paz para que a
limpeza de labels não gere novas cobranças.

## `area:` (onde)

- `area: build` — `scripts/**`, `.mango/**`, `apps/api/src/lib/{config,runtime-paths}.ts`, `tsconfig*.json`, `turbo.jsonc`, `cliff.toml`, `Dockerfile*`, `.dockerignore`
- `area: cli` — `apps/api/src/cli/**`, `apps/api/src/index.ts`, `apps/api/src/server/**`, `apps/api/src/lib/{server-state,mango-paths}.ts`, `packages/cargo-shim/**`
- `area: tooling` — `biome.json`, `dprint.json`, `lefthook.yml`, `opencode.json`, `.editorconfig`, `.gitattributes`, `.gitmessage`, `.gitignore`, `.claude/**`, `.agents/skills/**`
- `area: db` — `apps/api/src/db/**`
- `area: docs` — `docs/**`, `*.md` em qualquer app ou pacote, `LICENSE`, `.github/**/*.md`, templates de issue/PR
- `area: frontend` — `apps/frontend/**`
- `area: api` — `apps/api/**`
- `area: shared` — `apps/shared/**`
- `area: git` — `apps/api/src/modules/{git,github}/**`, `apps/frontend/src/features/workspace/**`, `apps/shared/src/{git,github}/**`
- `area: auth` — entrypoints de auth + `apps/shared/src/auth/**` + `tests/browser-smoke/auth-flow.spec.ts`
- `area: chat` — `apps/api/src/modules/{chats,messages}/**`, `apps/frontend/src/features/chat/**`, `apps/shared/src/chat/**`
- `area: generation` — `apps/api/src/modules/generation/**`, `apps/frontend/src/features/generation/**`, `apps/frontend/src/services/generation-service.ts`, `apps/shared/src/generation/**`
- `area: gallery` — API de imagens geradas + storage + galeria no frontend
- `area: providers` — adaptadores de provider, `apps/shared/src/catalog/**`, hook do catálogo de modelos
- `area: connectors` — módulos de connector, secret store, `apps/shared/src/connectors/**`
- `area: settings` — módulos de settings de app/provider/tool + settings no frontend
- `area: tools` — registro de tools, settings de tools, `apps/shared/src/tool-settings/**`
- `area: skills` — `apps/api/src/modules/skills/**`, `apps/frontend/src/features/settings/skills/**`, `apps/shared/src/skills/**`
- `area: mcp` — `apps/api/src/services/mcp/**`, `apps/api/src/modules/mcp-servers/**`, `apps/frontend/src/features/settings/mcp/**`, `apps/shared/src/mcp/**`
- `area: i18n` — `apps/shared/src/i18n/**`
- `area: components` — `apps/frontend/src/components/**`

## `type:` (o quê)

- `type: ci` — `.github/{workflows,actions,labeler.yml,dependabot.yml}`
- `type: dependencies` — `package.json`, `bun.lock` (também aplicada automaticamente pelo Dependabot nos ecossistemas `bun`, `github-actions`, `cargo` e `docker`)
- `type: test` — `**/*.{test,spec}.{ts,tsx}`, `scripts/tests/**`, `tests/**`, `playwright.config.ts`
- `type: refactor` — manual, espelha o tipo `refactor` de Conventional Commit
- `type: perf` — manual, espelha o tipo `perf` de Conventional Commit
- `type: docs` — manual, espelha o tipo `docs` de Conventional Commit
- `type: security` — manual, mudanças sensíveis a segurança
- `type: hardening` — manual, trabalho defensivo que fecha uma classe de bugs
- `type: chore` — manual, manutenção que não se encaixa em nenhum outro tipo
- `type: bug`, `type: feature`, `type: migration`, `type: question` — manual / padrões dos templates de issue

## `status:` (somente issues)

Issues carregam exatamente uma label `status:`. Nenhum glob aplica essas labels — o
`issue-triage.yml` semeia a primeira e os mantenedores a movem manualmente a partir daí.

- `status: needs triage` — padrão na abertura (templates de issue e o backstop do `issue-triage.yml`)
- `status: needs author` — aguardando o autor; também aplicada automaticamente quando uma issue aberta tem zero ou várias labels `type:`
- `status: accepted` — triada e aceita, ainda não iniciada
- `status: in progress` — em desenvolvimento ativo
- `status: blocked` — aceita, mas aguardando algo externo

## Adicionar ou mover uma label

Mantenha novas labels e mudanças de glob em sincronia entre `.github/labeler.yml`,
`.github/dependabot.yml` e esta página. `scripts/tests/labeler.unit.test.ts` garante que o
conjunto de labels `area:`/`type:` documentado aqui é igual ao definido em `.github/labeler.yml`
(mais as labels manuais acima), então uma label adicionada em um lugar e não no outro falha o
teste pelo nome. O texto dos globs em cada item e a lista de `status:` **não** são verificados —
mantenha-os corretos manualmente.

## Relacionado

- Checks obrigatórios e gates agregados: [`ci.md`](./ci.md)
- Fluxo de contribuição: [`../guides/contributor-quickstart.md`](../guides/contributor-quickstart.md)
