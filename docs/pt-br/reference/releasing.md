# Releases

O MangoStudio é distribuído como binários standalone (GitHub Releases), imagem
Docker no GHCR, CLI npm (`mangostudio`), tap Homebrew, bucket Scoop
(Windows) e crate launcher no crates.io (`cargo install mangostudio`). O
changelog é gerado a partir de Conventional Commits com
[git-cliff](https://git-cliff.org); nada é editado manualmente.

> 🇺🇸 [English version](../../reference/releasing.md)

## Contrato one-shot

Configure os secrets abaixo e faça push de uma tag semver assinada (`v0.2.0`) —
esse é o procedimento completo de release. O workflow valida lockstep de versão,
gera todos os artefatos, publica cada canal de forma independente e faz commit de
`CHANGELOG.md` de volta em `main` via push direto ou PR criada pela API REST.

| Secret                      | Usado por                                                | Escopo                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                 | `npm-publish`, `npm-canary`                              | Direitos de publicação em `mangostudio` e `@mangostudio/cli-*`                                                                                                                                                                |
| `DIST_REPOS_TOKEN`          | `homebrew`, `scoop`                                      | PAT fine-grained com contents read/write em `juliopolycarpo/homebrew-tap` e `juliopolycarpo/scoop-bucket`                                                                                                                     |
| `CARGO_REGISTRY_TOKEN`      | `cargo-publish`                                          | Fallback temporário no crates.io até Trusted Publishing estar registrado e verificado para o crate `mangostudio`                                                                                                              |
| `CHANGELOG_PR_TOKEN`        | `update-changelog`                                       | PAT fine-grained com pull requests read/write neste repositório; usado só quando a proteção de branch rejeita o push direto do changelog                                                                                      |
| *(built-in `GITHUB_TOKEN`)* | `github-release`, `docker`, o canal canary, attestations | Sem setup extra — releases por tag concedem `packages: write` para GHCR e `contents: write` para o `update-changelog` gravar o commit de changelog verificado via REST API, e `id-token: write` para a auth OIDC do crates.io |

### Checklist de setup único

Complete uma vez por fork ou org antes do primeiro push de tag:

1. Crie o tap Homebrew compartilhado [`juliopolycarpo/homebrew-tap`](https://github.com/juliopolycarpo/homebrew-tap) com diretório `Formula/`.
2. Crie o bucket Scoop compartilhado [`juliopolycarpo/scoop-bucket`](https://github.com/juliopolycarpo/scoop-bucket) com diretório `bucket/`.
3. Reserve o nome do crate `mangostudio` no [crates.io](https://crates.io) e gere um token de API para o primeiro publish.
4. Configure Trusted Publishing no crates.io para o crate `mangostudio`: **Settings -> Trusted Publishing -> Add -> GitHub**, repository owner `juliopolycarpo`, repository name `mangostudio`, workflow filename `release.yml`, sem environment a menos que o job de release passe a usar um GitHub environment.
5. Adicione os repo secrets (`NPM_TOKEN`, `DIST_REPOS_TOKEN`, `CHANGELOG_PR_TOKEN` e o fallback temporário `CARGO_REGISTRY_TOKEN`) neste repositório.
6. Depois que uma release provar que `cargo-publish` gerou o token de Trusted Publishing, remova o secret `CARGO_REGISTRY_TOKEN`. Até lá, o job usa o secret como fallback se o crates.io ainda não aceitar o publisher OIDC.
7. Após o primeiro push no GHCR, defina a visibilidade do pacote `ghcr.io/juliopolycarpo/mangostudio` como **public** nas configurações de pacotes do GitHub.
8. Não é preciso afrouxar a proteção de branch para o changelog: o job `update-changelog` faz push direto de `CHANGELOG.md` em `main` quando possível (`contents: write`) e, se a proteção rejeitar o push, cria uma PR com `CHANGELOG_PR_TOKEN` pela API REST do GitHub. Revise e faça merge dessa PR depois que os checks passarem.

## Nomenclatura de assets de release

Todo canal downstream (Homebrew, Scoop, launcher Cargo, os scripts de
instalação do mangostudio.dev) codifica estes nomes públicos de assets. Não os
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

Os scripts de instalação **não** são assets de release. Os instaladores
canônicos ficam hospedados em [mangostudio.dev](https://mangostudio.dev)
(`install.sh` / `install.ps1`) e baixam os arquivos de plataforma acima,
verificando-os contra `SHA256SUMS`. O repositório mantém
`scripts/install/install.sh` apenas como fixture de teste do dry-run.

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

1. Faça bump da versão em todos os `package.json` lockstep e em
   `packages/cargo-shim/Cargo.toml`, depois atualize o lockfile com
   `cargo update --workspace` (dentro de `packages/cargo-shim/`).
2. Rode `bun run check:versions` e faça commit do bump.
3. Crie e faça push da tag (deve coincidir com a versão commitada):

   ```bash
   git tag -s v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

**Re-run failed jobs** é sempre seguro: jobs de canal são independentes — uma
falha nunca bloqueia as outras. Versões npm já publicadas são ignoradas, assets
de release usam clobber e o push do changelog faz rebase antes de retentar. Para
durabilidade extra: artefatos de build retêm por 30 dias, o job `docker` retenta
cada push multi-arch e baixa o GitHub Release publicado se o artefato expirou, e o
job `release-summary` (sempre executa) escreve uma tabela ✅/❌ por canal.

O workflow executa 14 jobs: `build`, `verify-build`, `github-release`, `docker`,
`verify-image`, `npm-publish`, `homebrew`, `scoop`, `cargo-publish`,
`verify-release`, `verify-cargo`, `verify-homebrew`, `update-changelog` e
`release-summary`. Veja a
[versão em inglês](../../reference/releasing.md#cutting-a-release) para a tabela
completa de jobs e detalhes por canal (npm, Docker, Homebrew, Scoop, crates.io).
