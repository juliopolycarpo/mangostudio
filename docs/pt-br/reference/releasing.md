# Releases

O MangoStudio é distribuído como binários standalone (GitHub Releases), imagem
Docker no GHCR, CLI npm (`mangostudio`), tap Homebrew, bucket Scoop
(Windows) e crate launcher no crates.io (`cargo install mangostudio`). O
changelog é gerado a partir de Conventional Commits com
[git-cliff](https://git-cliff.org) na preparação da release e verificado no
momento da tag; nada é editado manualmente.

> 🇺🇸 [English version](../../reference/releasing.md)

## Contrato one-shot

Com os secrets abaixo configurados, a release é `bun run release:prepare
<versão>`, um commit e o push de uma tag semver assinada (`v0.2.0`). O workflow
valida o lockstep de versão e o changelog pré-tag, gera todos os artefatos e
publica cada canal de forma independente. A tag carrega o próprio
`CHANGELOG.md` — nada é escrito de volta em `main` após a release.

| Secret                      | Usado por                                                | Escopo                                                                                                                      |
| --------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                 | `npm-publish` (env opcional), `npm-canary` (repo)        | Token legado só quando `workflow_dispatch` define `allow_legacy_npm_token=true`; secret do repositório para canary          |
| `DIST_REPOS_TOKEN`          | `homebrew`, `scoop`                                      | Secret do environment `release` — PAT fine-grained com contents read/write no tap Homebrew e no bucket Scoop                |
| `CARGO_REGISTRY_TOKEN`      | `cargo-publish` (opcional)                               | Token legado do crates.io usado só quando `workflow_dispatch` define `allow_legacy_cargo_token=true`                        |
| *(built-in `GITHUB_TOKEN`)* | `github-release`, `docker`, o canal canary, attestations | Sem setup extra — releases por tag concedem `packages: write` para GHCR e `id-token: write` para OIDC do crates.io e do npm |

### Environment `release`

As credenciais de publish estável vivem no GitHub Environment `release`, não
como secrets soltos no repositório:

- **Branches e tags de deployment:** restritas a tags `v*.*.*`.
- **Reviewers obrigatórios:** nenhum — o push de uma tag ainda libera a release
  sem intervenção.
- **Jobs que o declaram:** `github-release`, `docker`, `npm-publish`,
  `homebrew`, `scoop` e `cargo-publish`. Um novo canal de publish entra neste
  environment; não se adiciona um secret de repositório.
- **Canary fica de fora:** `.github/workflows/canary.yml` publica a cada push
  verde em `main`, o que a regra de tag bloquearia. Continua usando o
  `NPM_TOKEN` com escopo de repositório.
- **Dispatch manual:** como o environment é restrito a tags, um
  `workflow_dispatch` de `release.yml` precisa apontar para uma ref de tag
  `v*.*.*` (`gh workflow run release.yml --ref v0.2.0`), não para um branch.

### Checklist de setup único

Complete uma vez por fork ou org antes do primeiro push de tag:

1. Crie o tap Homebrew compartilhado [`juliopolycarpo/homebrew-tap`](https://github.com/juliopolycarpo/homebrew-tap) com diretório `Formula/`.
2. Crie o bucket Scoop compartilhado [`juliopolycarpo/scoop-bucket`](https://github.com/juliopolycarpo/scoop-bucket) com diretório `bucket/`.
3. Reserve o nome do crate `mangostudio` no [crates.io](https://crates.io) e gere um token de API só se ainda precisar do fallback legado temporário.
4. Configure Trusted Publishing no crates.io para o crate `mangostudio`: **Settings -> Trusted Publishing -> Add -> GitHub**, repository owner `juliopolycarpo`, repository name `mangostudio`, workflow filename `release.yml`, e deixe o campo de environment vazio. O job `cargo-publish` declara `environment: release`, mas configs do crates.io sem environment continuam batendo — só preencha o environment no crates.io se quiser exigir um de propósito.
5. Crie o GitHub Environment `release` (regra de tag `v*.*.*`, sem reviewers) e adicione `DIST_REPOS_TOKEN` como secret do **environment**. Mantenha `NPM_TOKEN` no environment só enquanto o escape hatch `allow_legacy_npm_token` ainda puder ser necessário. Mantenha um `NPM_TOKEN` com escopo de repositório para o canary. Mantenha `CARGO_REGISTRY_TOKEN` só enquanto o escape hatch `allow_legacy_cargo_token` ainda for necessário. Depois de uma release verde pelo environment, remova o `DIST_REPOS_TOKEN` de nível de repositório.
6. Depois que uma release provar que `cargo-publish` gerou o token de Trusted Publishing, revogue e remova `CARGO_REGISTRY_TOKEN`.
7. Configure Trusted Publishing no npm para `mangostudio` e cada pacote `@mangostudio/cli-*` (**Settings -> Trusted Publisher**): repositório `juliopolycarpo/mangostudio`, workflow `release.yml`, environment `release`, ação `npm publish`. O npm permite só um trusted publisher por pacote; o canary continua com `NPM_TOKEN` do repositório (o workflow validado seria `ci.yml`, não `canary.yml`). Não ative “disallow tokens” no npm enquanto o canary precisar de token.
8. Após a primeira release estável verde via OIDC no npm, remova o `NPM_TOKEN` do environment `release` se o caminho legado não for mais necessário.
9. Após o primeiro push no GHCR, defina a visibilidade do pacote `ghcr.io/juliopolycarpo/mangostudio` como **public** nas configurações de pacotes do GitHub.
10. Não é preciso token extra nem ajuste de proteção de branch para o changelog: `CHANGELOG.md` entra em `main` no commit de preparação da release (`bun run release:prepare`) **antes** do push da tag, e o workflow de release apenas verifica que ele está lá.

## Nomenclatura de assets de release

Todo canal downstream (Homebrew, Scoop, launcher Cargo, os scripts de
instalação em `scripts/install/`) codifica estes nomes públicos de assets. Não os
renomeie sem atualizar todos os templates e instaladores na mesma release.

| Asset                                        | Notas                              |
| -------------------------------------------- | ---------------------------------- |
| `mangostudio-<version>-<platform>.tar.gz`    | Plataformas Linux e macOS          |
| `mangostudio-<version>-<platform>.zip`       | Plataformas Windows                |
| `mangostudio-<version>-frontend-dist.tar.gz` | Bundle do frontend apenas          |
| `SHA256SUMS`                                 | Checksums de todos os assets acima |

Cada arquivo de plataforma tem **raiz plana**: `mangostudio` (ou
`mangostudio.exe`) e `README.md` — sem diretório de plataforma aninhado. O
binário embarca a UI do frontend; nenhum diretório de assets vizinho é
necessário em tempo de execução.

Os scripts de instalação são assets de release nos dois canais, copiados sem
alteração de `scripts/install/` para `release-assets/` e listados em
`SHA256SUMS` ao lado dos arquivos que instalam. As URLs canônicas são
`https://github.com/juliopolycarpo/mangostudio/releases/latest/download/install.sh`
e `.../install.ps1`; ambos baixam os arquivos de plataforma acima e os verificam
contra `SHA256SUMS`. O binário do hub embute os mesmos bytes e os executa
localmente em `mangostudio upgrade` (`--local`, `--use`, `--prune`,
`--uninstall`); o dry-run compara `mangostudio __installer sh` com o arquivo do
repositório para que os dois não divirjam.

## Fonte da versão

Existe **uma** versão de release. A `version` do `package.json` raiz é canônica;
a variável de ambiente `VERSION` (definida pelo workflow a partir da tag) a
sobrescreve. `bun run check:versions` valida lockstep entre root, workspaces,
`packages/cli` e `packages/cargo-shim/Cargo.toml`/`Cargo.lock`.

## Canal canary

Todo commit que entra verde em `main` é publicado como **canary**. O job `canary`
em `.github/workflows/ci.yml` é gated em todos os outros jobs de CI passarem e em
um push para `main`, então o commit que acabou de ficar verde é a fonte do canary
— sem trigger separado. Ele chama o reutilizável `.github/workflows/canary.yml`.

npm usa `<versão-raiz>-canary.<sha7>` (ex.: `0.1.0-canary.1234abc`). O GitHub
Releases usa um pre-release rolling `v<versão-raiz>-canary` cujas notas registram
o SHA de origem e a versão canary completa. Os nomes dos assets ficam fixos em
`<versão-raiz>-canary` para o launcher Cargo canary já publicado continuar
resolvendo-os. Consuma builds canary via npm ou pelos arquivos do GitHub
pre-release:

```bash
# npm — a dist-tag `canary`; `latest` nunca é tocado
npm install -g mangostudio@canary
# GitHub Releases — arquivos do pre-release rolling e SHA256SUMS
gh release download v0.1.0-canary --repo juliopolycarpo/mangostudio
# Cargo — o launcher prerelease fixo já publicado, apoiado pelos assets rolling
cargo install mangostudio --version 0.1.0-canary
```

- **GitHub Releases** (`github-release-canary`): assets do pre-release rolling
  `v<root>-canary` e `SHA256SUMS`, sobrescritos a cada commit verde em `main` e
  nomeados para o launcher Cargo fixo.
- **npm** (`npm-canary`): `mangostudio` na dist-tag `canary`, então `latest`
  nunca aponta para um canary.

Cada canal é independente e idempotente (igual à release por tag): uma falha não
bloqueia a outra e **Re-run failed jobs** re-executa só o canal que falhou (o
job `canary-summary` escreve uma tabela ✅/❌ por canal). O grupo de concorrência
`canary-publish` cancela runs superadas em voo, então o pre-release rolling e a
dist-tag npm sempre acompanham o commit verde mais recente; versões npm por
commit são únicas, então um run cancelado nunca deixa um half-publish
conflitante.

Ressalvas:

- `ghcr.io/juliopolycarpo/mangostudio:canary` e `:canary-<sha7>` não são mais
  atualizados. As tags GHCR canary existentes permanecem no registry até serem
  limpas manualmente. Releases por tag ainda publicam o conjunto completo de
  imagens Docker.
- O workflow não publica mais canaries no crates.io. O launcher `<root>-canary`
  atualmente publicado continua funcionando porque os assets do pre-release
  rolling no GitHub seguem sendo atualizados sob os mesmos nomes.
- Tags `v<version>-canary.<sha7>` continuam excluídas do trigger de release
  (`!v*-canary*`) como guarda para tags antigas ou manuais.

## Cortar uma release

Releases são orientadas por tag. A partir de um `main` atualizado:

1. Prepare a release — um comando faz bump de todos os manifests lockstep,
   regenera `CHANGELOG.md` com git-cliff e re-executa
   `check:versions --expect` como autoverificação:

   ```bash
   bun run release:prepare 0.2.0
   ```

2. Faça commit da árvore preparada como o commit de preparação da release
   (`cliff.toml` ignora commits `chore(release)`, então ele nunca reentra em um
   changelog futuro):

   ```bash
   git add -A && git commit -s -S -m "chore(release): v0.2.0"
   ```

3. Depois que esse commit entrar em `main` (pelo fluxo normal de PR), crie e
   faça push da tag (deve coincidir com a versão commitada):

   ```bash
   git tag -s v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

Uma tag cujo commit não tenha a seção de changelog ou uma versão em lockstep
falha no job `prepare` antes de qualquer artefato ser produzido, apontando a
correção (`bun run release:prepare`). O mesmo job recusa liberar um commit que
não seja ancestral de `origin/main` ou cujo **`CI / Gate`** agregado não tenha
concluído com `success`. O gate é resolvido pela própria run de push em `main` do
`ci.yml` para o commit, e não pelo nome da check run, porque `cargo-shim.yml` e
`release-dry-run.yml` também expõem um job chamado `Gate`. Push de tag não pode
pular esse gate de proveniência, e um gate ainda em execução também bloqueia —
espere o CI ficar verde em `main` antes de empurrar a tag. Só
**`workflow_dispatch`** pode definir `allow_unverified_source=true` como escape
deliberado (registrado como aviso no workflow); use quando a run de CI sumiu da
API mas o commit ainda é o da release, e mencione o bypass nas notas de release.

**Re-run failed jobs** é sempre seguro: jobs de canal são independentes — uma
falha nunca bloqueia as outras. Versões npm já publicadas são ignoradas e assets
de release usam clobber. Para durabilidade extra: artefatos de build retêm por
30 dias, o job `docker` retenta cada push multi-arch contra o artefato de
distribuição verificado, e o job `release-summary` (sempre executa) escreve uma
tabela ✅/❌ por canal mais o resultado de auth/provenance do npm e do crates.io.

O workflow executa 14 jobs: `prepare`, `build`, `verify-build`, `github-release`, `docker`,
`verify-image`, `npm-publish`, `homebrew`, `scoop`, `cargo-publish`,
`verify-release`, `verify-cargo`, `verify-homebrew` e
`release-summary`. Veja a
[versão em inglês](../../reference/releasing.md#cutting-a-release) para a tabela
completa de jobs e detalhes por canal (npm, Docker, Homebrew, Scoop, crates.io).
