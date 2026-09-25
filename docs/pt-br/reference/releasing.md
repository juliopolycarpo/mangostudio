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
7. Configure Trusted Publishing no npm para `mangostudio` e cada pacote `@mangostudio/cli-*` (**Settings -> Trusted Publisher**): repositório `juliopolycarpo/mangostudio`, workflow `release.yml`, environment `release`, ação `npm publish`. O npm permite até 10 trusted publishers por pacote, então uma segunda linha poderia registrar o workflow chamador do canary, `ci.yml` (não `canary.yml`) — mas `.github/workflows/canary.yml` sempre exige e usa o `NPM_TOKEN` do repositório hoje; registrar essa linha não remove a necessidade do token até que o próprio workflow migre para OIDC (fora do escopo aqui). Não ative “disallow tokens” no npm enquanto o canary ainda precisar desse token.
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

### Como o binário do runtime é construído

O hub é compilado com Bun; `mangostudio-runtime` é o binário cargo de
`crates/mangostudio-runtime`. `distribution-build.yml` chama
`.github/workflows/runtime-build.yml`, que constrói cada um dos oito alvos num
runner capaz de linká-lo e o envia como artefato
`runtime-<source-sha>-<platform-id>`. O job de empacotamento baixa esses
artefatos em `.mango/runtime-prebuilt/` e roda
`bun run build --binary --runtime-dir .mango/runtime-prebuilt`, que compila
apenas os hubs e copia cada runtime ao lado do seu hub. Nada depois de
`.mango/out/<platform>/` mudou: arquivos, assets crus, `SHA256SUMS`, pacotes npm,
imagens Docker e instaladores veem os mesmos dois arquivos de antes.

| Plataformas                          | Runner           | Alvo Rust / toolchain                                           |
| ------------------------------------ | ---------------- | --------------------------------------------------------------- |
| `linux-x64`, `linux-arm64`           | `ubuntu-latest`  | `<arch>-unknown-linux-gnu.2.17` via cargo-zigbuild (piso glibc) |
| `linux-x64-musl`, `linux-arm64-musl` | `ubuntu-latest`  | `<arch>-unknown-linux-musl` via cargo-zigbuild (estático)       |
| `darwin-x64`, `darwin-arm64`         | `macos-latest`   | `x86_64-apple-darwin` / `aarch64-apple-darwin`, Xcode           |
| `windows-x64`, `windows-arm64`       | `windows-latest` | `x86_64-pc-windows-msvc` / `aarch64-pc-windows-msvc`, MSVC      |

- **Piso de glibc: 2.17.** O hub compilado com Bun já exige `GLIBC_2.17` (seu
  símbolo versionado mais alto nas duas arquiteturas), então linkar o runtime no
  mesmo piso não acrescenta requisito ao par. `GLIBC_FLOOR` em
  `scripts/lib/runtime-build.ts` é o único lugar que o nomeia.
- **Dependências C e assembly.** `ring` e `rquickjs-sys` são compilados por
  alvo; `aws-lc` não está no grafo. No Linux o zig é o toolchain C deles;
  `windows-arm64` é compilado de forma cruzada na imagem Windows x64, que traz as
  bibliotecas MSVC ARM64 e o clang de que o `ring` precisa.
- **Pins.** Rust vem de `rust-toolchain.toml`; zig é baixado com versão e
  SHA-256 fixos (`ZIG_VERSION`/`ZIG_SHA256`); cargo-zigbuild é instalado em
  versão fixa pelo `taiki-e/install-action`, que verifica o checksum.
- **Versão.** Cada runtime recebe a versão da release em tempo de compilação via
  `MANGOSTUDIO_RELEASE_VERSION` e a imprime sozinha em `--version`, a linha que o
  doctor do hub e o provisionamento WSL/SSH comparam literalmente.
- **Verificações.** `scripts/build-runtime.ts` e o staging com `--runtime-dir`
  leem o cabeçalho de cada binário (`scripts/lib/executable-header.ts`): formato,
  CPU, loader glibc ou binário estático, e nenhum símbolo `GLIBC_` acima do piso.
  Um runtime executável na máquina também precisa responder `--version` com a
  versão da release.

Localmente, `bun run build --binary --platform <host>` roda
`cargo build --release --locked -p mangostudio-runtime --target <triple>` para o
alvo do próprio host. Qualquer outro alvo precisa de um runtime pré-construído em
`--runtime-dir <dir>` (ou `RUNTIME_DIR`), no layout
`<dir>/<platform-id>/mangostudio-runtime[.exe]` — por exemplo, de
`bun run build:runtime --platform linux-arm64 --zig --out <dir>`. Um arquivo
ausente é um erro que o nomeia; o build nunca usa outro runtime no lugar.

## Fonte da versão

Existe **uma** versão de release. A `version` do `package.json` raiz é canônica;
a variável de ambiente `VERSION` (definida pelo workflow a partir da tag) a
sobrescreve. `bun run check:versions` valida lockstep entre root, workspaces,
`packages/cli`, `crates/mangostudio-launcher/Cargo.toml` e a entrada do launcher
no `Cargo.lock` raiz. A versão do protocolo no mesmo lockfile continua independente.

## Canal canary

Todo commit que entra verde em `main` é publicado como **canary**. O job `canary`
em `.github/workflows/ci.yml` é gated no `CI / Gate` agregado e em um push para
`main`, então o commit que acabou de ficar verde é a fonte do canary — sem
trigger separado. Ele chama o reutilizável `.github/workflows/canary.yml`.

Este repositório tem **releases imutáveis** habilitadas, então o canary não é
mais uma pre-release rolling: ele corta **uma release por commit verde**,
com tag `v<versão>` usando a versão com SHA que os binários reportam (ex.:
`v0.1.1-canary.abc1234`). Os assets não são mais renomeados para uma versão
rolling — mantêm o nome de build, por exemplo
`mangostudio-0.1.1-canary.abc1234-linux-x64.tar.gz`. A pre-release rolling
`v<root>-canary` publicada antes de 2026-09-16 fica congelada e imutável;
nada a republica, e hubs instalados a partir dela continuam resolvendo-a.
Consuma builds canary via npm ou pelos arquivos da pre-release mais recente:

```bash
# npm — a dist-tag `canary`; `latest` nunca é tocado
npm install -g mangostudio@canary

# GitHub Releases — os arquivos da pre-release canary mais recente e SHA256SUMS
gh release download --repo juliopolycarpo/mangostudio \
  "$(gh release list --repo juliopolycarpo/mangostudio --json tagName,isPrerelease \
    --jq 'map(select(.isPrerelease and (.tagName | test("-canary")))) | first | .tagName')"

# Um hub instalado — canary mais recente, ou um commit específico
mangostudio upgrade --canary
mangostudio upgrade --canary 1234abc
```

- **GitHub Releases** (`github-release-canary`): uma pre-release `v<versão>`
  por commit verde em `main`, com seus assets e `SHA256SUMS`. Releases antigas
  são podadas por `scripts/release/prune-canary-releases.ts` (mantém 14 por
  padrão), junto com suas tags — o ruleset `release tags` exclui
  `refs/tags/v*-canary.*`; qualquer outra tag `v*` continua sem poder ser
  apagada nem movida. A janela conta apenas releases publicadas: um upload
  interrompido nunca desaloja um build que os hubs ainda usam, e o draft que ele
  deixou para trás é apagado de qualquer forma.
- **npm** (`npm-canary`): `mangostudio@<versão>` na dist-tag `canary`, então
  `latest` nunca aponta para um canary.

Nada reconstrói mais uma tag canary a partir de uma versão: `install.sh
--canary`, `install.ps1 -Canary` e a verificação de atualização do hub sempre
resolvem a pre-release canary mais recente na lista de releases do GitHub.

Cada canal é independente e idempotente (igual à release por tag): uma falha não
bloqueia a outra e **Re-run failed jobs** re-executa só o canal que falhou (o
job `canary-summary` escreve uma tabela ✅/❌ por canal). O grupo de concorrência
`canary-publish` cancela runs superadas em voo, então a dist-tag npm sempre
acompanha o commit verde mais recente; versões npm por commit são únicas,
então um run cancelado nunca deixa um half-publish conflitante.

Ressalvas:

- `ghcr.io/juliopolycarpo/mangostudio:canary` e `:canary-<sha7>` não são mais
  atualizados. As tags GHCR canary existentes permanecem no registry até serem
  limpas manualmente. Releases por tag ainda publicam o conjunto completo de
  imagens Docker.
- O workflow não publica mais canaries no crates.io. O launcher `<root>-canary`
  atualmente publicado continua funcionando porque aponta para a pre-release
  `v<root>-canary` congelada — releases imutáveis significam que os assets
  dela nunca podem ser substituídos, então a URL do launcher continua
  resolvendo mesmo que essa release nunca mais seja republicada. Nenhum crate
  canary novo é publicado, e um bump futuro de versão raiz não ganha um
  `<root>-canary` a menos que o publish canary no crates.io seja
  reintroduzido de propósito.
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
falha nunca bloqueia as outras. Versões npm já publicadas são ignoradas, e um
re-run contra uma GitHub Release já publicada verifica os assets em vez de
reenviá-los — releases imutáveis não podem receber clobber. Para durabilidade
extra: artefatos de build retêm por
30 dias, o job `docker` retenta cada push multi-arch contra o artefato de
distribuição verificado, e o job `release-summary` (sempre executa) escreve uma
tabela ✅/❌ por canal mais o resultado de auth/provenance do npm e do crates.io.

O workflow executa 14 jobs: `prepare`, `build`, `verify-build`, `github-release`, `docker`,
`verify-image`, `npm-publish`, `homebrew`, `scoop`, `cargo-publish`,
`verify-release`, `verify-cargo`, `verify-homebrew` e
`release-summary`. Veja a
[versão em inglês](../../reference/releasing.md#cutting-a-release) para a tabela
completa de jobs e detalhes por canal (npm, Docker, Homebrew, Scoop, crates.io).
