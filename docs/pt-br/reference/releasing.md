# Releases

O MangoStudio é distribuído como binários standalone (GitHub Releases), imagem
Docker no GHCR, CLI npm (`@mangostudio/cli`), tap Homebrew, bucket Scoop
(Windows) e crate launcher no crates.io (`cargo install mangostudio`). O
changelog é gerado a partir de Conventional Commits com
[git-cliff](https://git-cliff.org); nada é editado manualmente.

> 🇺🇸 [English version](../../reference/releasing.md)

## Contrato one-shot

Configure os secrets abaixo e faça push de uma tag semver assinada (`v0.2.0`) —
esse é o procedimento completo de release. O workflow valida lockstep de versão,
gera todos os artefatos, publica cada canal de forma independente e faz commit de
`CHANGELOG.md` de volta em `main`.

| Secret                      | Usado por                                | Escopo                                                                                                                     |
| --------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`                 | `npm-publish`                            | Direitos de publicação em `@mangostudio/*`                                                                                 |
| `DIST_REPOS_TOKEN`          | `homebrew`, `scoop`                      | PAT fine-grained com contents read/write em `juliopolycarpo/homebrew-tap` e `juliopolycarpo/scoop-bucket`                  |
| `CARGO_REGISTRY_TOKEN`      | `cargo-publish`                          | Fallback temporário no crates.io até Trusted Publishing estar registrado e verificado para o crate `mangostudio`           |
| *(built-in `GITHUB_TOKEN`)* | `github-release`, `docker`, attestations | Sem setup extra — o workflow concede `packages: write` para GHCR; `cargo-publish` concede `id-token: write` para OIDC auth |

### Checklist de setup único

Complete uma vez por fork ou org antes do primeiro push de tag:

1. Crie o tap Homebrew compartilhado [`juliopolycarpo/homebrew-tap`](https://github.com/juliopolycarpo/homebrew-tap) com diretório `Formula/`.
2. Crie o bucket Scoop compartilhado [`juliopolycarpo/scoop-bucket`](https://github.com/juliopolycarpo/scoop-bucket) com diretório `bucket/`.
3. Reserve o nome do crate `mangostudio` no [crates.io](https://crates.io) e gere um token de API para o primeiro publish.
4. Configure Trusted Publishing no crates.io para o crate `mangostudio`: **Settings -> Trusted Publishing -> Add -> GitHub**, repository owner `juliopolycarpo`, repository name `mangostudio`, workflow filename `release.yml`, sem environment a menos que o job de release passe a usar um GitHub environment.
5. Adicione os repo secrets (`NPM_TOKEN`, `DIST_REPOS_TOKEN` e o fallback temporário `CARGO_REGISTRY_TOKEN`) neste repositório.
6. Depois que uma release provar que `cargo-publish` gerou o token de Trusted Publishing, remova o secret `CARGO_REGISTRY_TOKEN`. Até lá, o job usa o secret como fallback se o crates.io ainda não aceitar o publisher OIDC.
7. Após o primeiro push no GHCR, defina a visibilidade do pacote `ghcr.io/juliopolycarpo/mangostudio` como **public** nas configurações de pacotes do GitHub.
8. Garanta que a proteção de branch permita ao bot de release fazer push de `CHANGELOG.md` em `main` (`contents: write` no workflow).

## Nomenclatura de assets de release

Todo canal downstream (Homebrew, Scoop, launcher Cargo, instaladores shell)
codifica estes nomes públicos de assets. Não os renomeie sem atualizar todos os
templates e instaladores na mesma release.

| Asset                                        | Notas                                       |
| -------------------------------------------- | ------------------------------------------- |
| `mangostudio-<version>-<platform>.tar.gz`    | Plataformas Linux e macOS                   |
| `mangostudio-<version>-<platform>.zip`       | Plataformas Windows                         |
| `mangostudio-<version>-frontend-dist.tar.gz` | Bundle do frontend apenas                   |
| `install.sh` / `install.ps1`                 | Instaladores copiados de `scripts/install/` |
| `SHA256SUMS`                                 | Checksums de todos os assets acima          |

Cada arquivo de plataforma tem **raiz plana**: `mangostudio` (ou
`mangostudio.exe`), `public/` e `README.md` — sem diretório de plataforma
aninhado.

## Fonte da versão

Existe **uma** versão de release. A `version` do `package.json` raiz é canônica;
a variável de ambiente `VERSION` (definida pelo workflow a partir da tag) a
sobrescreve. `bun run check:versions` valida lockstep entre root, workspaces,
`packages/cli` e `packages/cargo-shim/Cargo.toml`/`Cargo.lock`.

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
de release usam clobber e o push do changelog faz rebase antes de retentar.

O workflow executa 13 jobs: `build`, `verify-build`, `github-release`, `docker`,
`verify-image`, `npm-publish`, `homebrew`, `scoop`, `cargo-publish`,
`verify-release`, `verify-cargo`, `verify-homebrew` e `update-changelog`. Veja a
[versão em inglês](../../reference/releasing.md#cutting-a-release) para a tabela
completa de jobs e detalhes por canal (npm, Docker, Homebrew, Scoop, crates.io).
