# Integração Contínua

Como o MangoStudio faz o gate de merges em `main`, e quais checks do GitHub são seguros para
exigir no ruleset.

## Gates agregados

Cada workflow com gate tem um agregado obrigatório com ID `gate-unique`.
Ele declara todas as lanes obrigatórias em `needs`, roda com `if: always()` e
avalia as dependências via `scripts/ci/evaluate-gate.ts`.

| Workflow                                                   | Contexto obrigatório da API em PRs       | Skips aceitos                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CI` (`ci.yml`)                                            | `CI Gate`                                | Distribution, smoke de binário e smoke de container somente quando a relevância da distribuição é exatamente `false`; cobertura Rust somente quando a relevância Rust é exatamente `false`; QA em dispatch manual; dry run exclusivo de PR em outros eventos |
| `Cargo Shim` (`cargo-shim.yml`)                            | `Cargo Shim Gate`                        | Cada lane Rust somente sob sua própria prova de relevância por caminhos                                                                                                                                                                                      |
| `Protocol CI` (`protocol-ci.yml`)                          | `Protocol Gate`                          | Lanes obrigatórias do protocolo somente quando a validação compilada não é necessária                                                                                                                                                                        |
| `Release Dry Run` (`release-dry-run.yml`), chamado pelo CI | `Release Dry Run / Release Dry Run Gate` | Lanes de asserção irrelevantes e o produtor limpo do runtime no caminho verificado de reutilização do mesmo run de PR                                                                                                                                        |

Chamadas de reusable workflows prefixam o nome do job folha com o nome do
job chamador. Runs agendados ou manuais independentes do Release Dry Run
reportam `Release Dry Run Gate`. Os jobs legados chamados `Gate` foram removidos.
O [snapshot dos checks obrigatórios](#proteção-de-branch--checks-obrigatórios)
registra os contextos únicos exigidos pelo ruleset de main. O Canary verifica
separadamente o CI bem-sucedido e os workflows relevantes pelos nomes únicos
de seus agregados.

Os skips de distribuição usam uma allowlist em
[`scripts/lib/ci-lanes.ts`](../../../scripts/lib/ci-lanes.ts), não uma regra geral de que
toda mudança Markdown é irrelevante. Em PRs, o job `changes` do CI coleta um diff validado,
não vazio e com os dois lados de renames; só emite `distribution=false` se todos os caminhos
estiverem na allowlist. Essa prova permite pular os jobs `distribution`, `smoke` (binário) e
`smoke-container`. Caminhos desconhecidos os executam; pushes e dispatches manuais também.
A relevância Rust e a do protocolo são independentes. O gate rejeita resultados de
relevância ausentes, falhas, cancelamentos e skips inesperados.

Os testes em `scripts/tests/ci-gate.unit.test.ts` derivam o `needs` esperado
do texto de cada workflow. `gate-compatibility.unit.test.ts` verifica os
produtores únicos, dependências obrigatórias e contratos de skips aceitos.
Adicionar uma lane obrigatória sem conectá-la ao agregado falha a validação.

## Relevância do protocolo e semver informativo

Protocol CI dispensa da validação compilada somente os sete guias de prosa
classificados em `docs/protocol/`. Spec, fixtures, política de contribuição,
caminhos desconhecidos e tooling do protocolo continuam relevantes. A regra é
separada da propriedade dos arquivos e dos checks locais; um novo guia exige
classificação explícita. PRs e pushes em main usam os caminhos alterados;
dispatch manual executa o workflow completo.

CI Check executa o check TypeScript do protocolo em PRs e pushes em main.
Protocol CI mantém seus testes TypeScript e a verificação do pacote publicado,
e executa o próprio check em dispatch independente. O job por mudança
`cargo-semver-checks (informational)` é informativo, inclusive em falhas de
setup, e fica fora das dependências de `Protocol Gate`. Feature powerset,
interop, igualdade de schema e validação do pacote continuam obrigatórios
quando relevantes.

## Rust mínimo suportado

Todos os crates Rust estáveis compartilham o mínimo intencional de Rust 1.99.0. Isso substitui o
piso 1.97.0 do workspace, que seguia stable-minus-two, e a exceção 1.96.0 do launcher publicado.
Todo membro estável herda `[workspace.package].rust-version` do `Cargo.toml` raiz, e o
`rust-toolchain.toml` fixa o mesmo compilador. Testes de política exigem essa igualdade. As versões
dos pacotes da aplicação e do protocolo continuam independentes. Veja
[suporte Rust e releases](./releasing.md#suporte-rust-e-releases) para a migração dos consumidores.

O Cargo Shim verifica o mínimo nos jobs nativos do workspace. A tabela mapeia cada check dos jobs
removidos para seu substituto na 1.99.0. Os checks de features padrão continuam separados dos
checks com todas as features, e os comandos exclusivos do launcher mantêm seu próprio grafo de
features das dependências.

| Antes                    | Comando e escopo de pacote/features                                                                                                                                                                             | Alvo e runner antes                                                                                   | Substituto na 1.99.0                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace-msrv`, 1.97.0 | `cargo check --workspace --locked`: bibliotecas/binários do workspace, features padrão                                                                                                                          | Linux x64, `ubuntu-latest`                                                                            | `workspace` em Linux x64, macOS arm64 e Windows x64, `cargo build --workspace --locked`                                              |
| `workspace-msrv`, 1.97.0 | `cargo check --workspace --all-targets --all-features --locked`: workspace, todo tipo de alvo e feature                                                                                                         | Linux x64, `ubuntu-latest`                                                                            | `workspace` em Linux x64, macOS arm64 e Windows x64, `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings` |
| `target-msrv`, 1.97.0    | `cargo check --workspace --all-targets --all-features --locked --target <t>`: workspace completo                                                                                                                | `aarch64-apple-darwin` em `macos-latest`; `x86_64-pc-windows-msvc` em `windows-latest`, ambos nativos | `workspace`, `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings` em cada runner nativo pelo alvo do host |
| `target-msrv`, 1.97.0    | Mesmo check do workspace completo, `--target aarch64-pc-windows-msvc`                                                                                                                                           | Check cruzado de Windows ARM64 a partir do `windows-latest` x64                                       | `workspace-windows-arm64` no `windows-11-arm` nativo, mesmo comando e alvo explícito                                                 |
| `target-msrv`, 1.96.0    | `cargo check -p mangostudio --all-targets --locked --target <t>`: launcher isolado, features padrão                                                                                                             | macOS arm64 e Windows x64 nativos                                                                     | `workspace` nesses runners, `cargo check -p mangostudio --all-targets --locked`; também roda em Linux x64                            |
| `target-msrv`, 1.96.0    | Mesmo check exclusivo do launcher, `--target aarch64-pc-windows-msvc`                                                                                                                                           | Check cruzado de Windows ARM64 a partir do `windows-latest` x64                                       | `workspace-windows-arm64` no `windows-11-arm` nativo, mesmo comando e alvo explícito                                                 |
| `launcher-msrv`, 1.96.0  | `cargo check -p mangostudio --all-targets --locked`, `cargo clippy -p mangostudio --all-targets --locked -- -D warnings`, `cargo test -p mangostudio --all-targets --locked`: launcher isolado, features padrão | Linux x64, `ubuntu-latest`                                                                            | `workspace` do Ubuntu mantém os três comandos; o check do launcher também roda em macOS arm64 e Windows x64                          |

Todas as linhas usam o mesmo sinal `RUST_WORKSPACE_PATHS` em `scripts/lib/rust-lanes.ts` antes e
depois da mudança e alimentam `Cargo Shim Gate`. `crates/**` seleciona mudanças só no runtime,
e `spec/**` e os demais arquivos lidos pelos crates selecionam mudanças do protocolo. Pull
requests sem um caminho Rust correspondente pulam os jobs sob a prova de relevância do gate,
que continua reportando. Pushes selecionados pelo filtro do workflow e dispatches manuais
executam os jobs Rust. O Protocol CI mantém seu sinal próprio do protocolo e não repete esses
checks de versão mínima.

Isso remove cinco instâncias de jobs Rust: um `workspace-msrv`, três pernas da matrix
`target-msrv` e um `launcher-msrv`. Encerra o suporte aos compiladores antigos e mantém a
cobertura de features e plataformas no novo mínimo. O build com features padrão e o Clippy
com todos os alvos e features substituem os dois checks do workspace. Esta mudança não apresenta
medição de redução de tempo ou de tamanho do cache.

O lock de fuzz excluído é resolvido no job Ubuntu `workspace` do Cargo Shim, no step
`Resolve excluded fuzz workspace`: `cargo metadata --manifest-path
crates/mango-protocol/fuzz/Cargo.toml --locked --all-features --format-version 1`.
É um step dentro de `Workspace (ubuntu-latest)`, não um job `fuzz-workspace` separado nem
um check obrigatório próprio. Um lock desatualizado reprova o job do workspace e seus gates.
O comando omite `--no-deps` de propósito para resolver o grafo; `short-job-folds.unit.test.ts`
fixa esse comportamento.

As validações independentes e a preparação de Bun/nextest usam `!cancelled()` para que um check
com falha não impeça os outros checks ou os testes nativos. Cada falha ainda reprova o job e o
gate agregado.

Os checks existentes continuam:

| Lane e gate agregado                         | Comando e escopo de pacote/features                                                                                                          | Cobertura de runners                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `workspace`, `Cargo Shim Gate`               | `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`; `cargo build --workspace --locked`                          | Linux x64, macOS arm64 e Windows x64 nativos                                                                           |
| `workspace`, `Cargo Shim Gate`               | `cargo fmt --all -- --check`                                                                                                                 | Somente Linux x64, `ubuntu-latest`                                                                                     |
| `workspace`, `Cargo Shim Gate`               | `cargo nextest run --workspace --all-targets --all-features --locked --retries 0`; paridade do inventário nextest/libtest                    | macOS arm64 e Windows x64 nativos                                                                                      |
| `rust-coverage`, `CI Gate`                   | `cargo llvm-cov --no-report --workspace --all-targets --all-features --locked`, libtest instrumentado                                        | Linux x64 nativo, mesmo sinal de caminhos Rust                                                                         |
| `workspace`, `Cargo Shim Gate`               | `cargo test --doc --workspace --all-features --locked`; `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --workspace --all-features --locked` | Linux x64; os doctests e docs específicos do protocolo em macOS/Windows continuam no Protocol CI                       |
| `workspace-windows-arm64`, `Cargo Shim Gate` | `cargo nextest run -p mangostudio-runtime --all-targets --all-features --locked --retries 0`                                                 | Windows ARM64 nativo, `windows-11-arm`, mesmo sinal de caminhos Rust                                                   |
| `musl-clippy`, `Cargo Shim Gate`             | `cargo-zigbuild clippy --locked -p mangostudio-runtime --all-targets --target <t> -- -D warnings`: runtime, features padrão                  | Checks cruzados em Linux para `x86_64-unknown-linux-musl` e `aarch64-unknown-linux-musl`, mesmo sinal de caminhos Rust |
| Protocol CI, `Protocol Gate`                 | Powerset de features do protocolo, interop, igualdade de schemas e checks do pacote publicado; semver consultivo separado                    | Sinal existente de caminhos do protocolo e cobertura Linux/macOS/Windows                                               |

O Ubuntu executa a suíte comportamental completa pelo libtest instrumentado, sem comparar
inventários com o nextest.

O Windows ARM64 agora compila o workspace completo e o launcher isolado na 1.99.0. O comando de
testes nativos continua limitado ao runtime; compilar o workspace completo não significa
executar os testes de todos os crates nesse alvo. A resolução do workspace de fuzz, a regeneração
da fixture ignorada e a qualificação do binário real mantêm seus comandos e critérios de
relevância.

## Evidência canônica do Check

O job reutilizável Check executa `bun run check --all --ci-report` uma vez e
retém `qa-check-evidence-<invocation>` por um dia. O relatório versionado vincula
repositório, SHA testado, run do Actions, tentativa produtora e um ID de
invocação gerado pelo chamador. Cinco workers TypeScript mantêm a supervisão
de processos e os timeouts existentes; seus diagnósticos e o resultado do
tooling compartilham esse relatório.

QA baixa e verifica a identidade desse relatório antes de consumir as métricas
de tooling e TypeScript. Um rerun só reutiliza uma tentativa anterior de Check
pelos outputs retidos da tentativa produtora e da invocação. Evidência ausente,
malformada, divergente ou interrompida fica indisponível; QA no CI não executa
os checkers novamente como fallback. A coleta local mantém os checks locais.
O relatório não substitui o resultado obrigatório de Check.

## Frontend de produção compartilhado

O job existente `Build (frontend + API)` produz o frontend canônico. Ele vincula
a revisão completa do Bun em execução ao hash da tarefa Turbo, limpa outputs
antigos antes do build, inclusive antes de um cache hit, registra a identidade
e faz upload antes do build ESM independente da API.
Preparação da distribuição, empacotamento nativo, asserções de produção no
browser e QA consomem esses bytes.

A verificação vincula SHA, commit exato do Bun produtor, lockfile, ambiente,
carimbo do build, metafile e inventário completo dos outputs. O compilador de
cada hub mantém sua própria identidade Bun separada. Não há outro job produtor
de frontend.

Distribution e browser exigem Build bem-sucedido. Se o build da API falhar,
o frontend permanece disponível para diagnóstico, mas esses consumidores não
prosseguem. QA coleta as outras métricas disponíveis e informa o bundle como
indisponível. QA verifica o frontend antes de baixar evidências não rastreadas
de Check, testes ou cobertura para o checkout. A preparação limpa de release
continua disponível quando não é fornecido um frontend compartilhado.

## Dry runs de release

CI chama `release-dry-run.yml` no mesmo run de Distribution Build em PRs,
mesmo quando os caminhos de release são irrelevantes. `Release Dry Run Gate`
mantém os skips por relevância; `CI Gate` inclui o resultado do reusable
workflow. PRs relevantes baixam os bundles endereçados por conteúdo de Linux
x64 e Windows x64 e verificam fonte, versão, canal, perfil e checksums por
`download-distribution`.

Cada plataforma empacota seu par de hub/runtime e README verificados com o
frontend preparado de `hub-inputs-*`. O README do alvo extraído é copiado para
`.mango/out/README.md` antes da criação do arquivo compactado. Empacotamento e instaladores
usam a versão do PR nas asserções de health, checksum, manifesto e ciclo de vida.
Eles não recompilam hub ou runtime. O gate aceita pular o produtor limpo do
runtime somente nesse caminho.

Distribution mantém os bundles por target e a validação completa de
empacotamento/manifesto em PRs, mas omite uploads agregados de checksums, assets
e npm sem consumidor. Main mantém esses bundles de publicação. O Canary diário
promove os artefatos shipping de um CI bem-sucedido em main após verificar seus
produtores; não há fallback de recompilação.

Dry runs semanais e manuais mantêm builds limpos e sem cache de runtime e hub,
com perfil shipping e versão `0.0.0-dryrun`. Checks Linux de empacotamento/Docker,
instaladores em Windows PowerShell 5.1 e Cargo publish dry run mantêm seus
comandos. O seed de cache light exclusivo de main aguarda o sucesso de `CI Gate` e do
job `changes` (Preflight), que resolve a identidade de distribuição. A reutilização hospedada e o custo
dos artefatos exigem validação no head atual; não há alegação de redução medida
de tempo.

## Dependências Rust resolvidas do zero

O `rust-fresh-dependencies.yml` resolve um novo lockfile Cargo da raiz toda terça
e em execuções manuais. Roda a política de dependências e build, clippy, testes do
workspace e doctests no Linux, macOS e Windows com o mesmo grafo. Falhas de
política não pulam os checks de plataforma. Os pins exatos do SDK continuam exatos. O
lock resolvido fica como artefato do workflow e nunca é commitado. Esse workflow
informativo não alimenta um gate obrigatório de PR. Falhas agendadas ou manuais
na `main` atualizam uma única issue do bot, preservando notas dos mantenedores; uma
execução manual em outra ref e a validação do workflow em PRs nunca escrevem issues.
O CI com lock e o Dependabot continuam independentes.

Toda execução não cancelada também guarda um artefato `fresh-rust-receipt` e um
resumo do passo ao lado do artefato `fresh-rust-lockfile`: o SHA do código, o
`rustc` e o `cargo` que resolveram o grafo, o SHA-256 do arquivo de lock avaliado
(o arquivo, não o arquivo compactado do artefato) e o resultado dos jobs
`resolve`, `policy` e `fresh`. Ele nomeia a etapa em que a execução terminou:
`resolution-failed` (nenhum lock existe), `lock-not-retained`, `policy-failed`,
`platform-checks-failed`, `policy-and-platform-checks-failed`, `passed` ou
`incomplete`. A issue de compatibilidade informa a mesma etapa, pela mesma
classificação (`scripts/ci/fresh-dependencies-receipt.mjs`), e só linka um lock
quando o artefato foi retido (um lock produzido mas não enviado mantém o hash no
recibo, marcado como não retido, sem link). O resultado de `fresh` cobre os três sistemas
operacionais juntos. O grafo é construído e testado com a toolchain de
desenvolvimento fixada (1.99.0) e unificação de features em todo o workspace
(`--workspace --all-features`). Verifica o novo grafo no mínimo compartilhado, mas não substitui
os checks de features padrão ou do launcher isolado contra o lock commitado. Um mínimo maior
não resolve uma falha da política de crates duplicados.

## Cobertura Rust

A execução dos testes Rust no Ubuntu é o `.github/workflows/rust-coverage.yml`,
chamado pelo `ci.yml` (não um passo do Cargo Shim): `cargo llvm-cov --no-report
--workspace --all-targets --all-features --locked`, os mesmos flags do passo
simples, no mesmo runner libtest, instrumentado. Ele vive no run do CI porque o
coletor do QA só baixa artefatos do próprio run e o publicador privilegiado lê
apenas o envelope `qa-metrics` desse run. Roda quando o job `changes` do
`ci.yml` vê um caminho de `RUST_WORKSPACE_PATHS` (e sempre em pushes, para que
todo envelope da `main` seja um baseline Rust); o `CI Gate` só aceita o skip
sob essa prova. Doctests, o run `--ignored` e a qualificação do binário real
ficam no Cargo Shim, sem instrumentação. Lane pulada por irrelevância deixa os
crates `unsupported` (não é lacuna); job devido que não entregou nada é
`unavailable`; teste com falha é `partial`; crate sem dados de profile é
`unavailable`, nunca 0%.

O smoke de navegador define `API_HOST=127.0.0.1` de propósito para seu endpoint IPv4.
O smoke de binário nativo remove `API_HOST` e `MANGOSTUDIO_DEFAULT_API_HOST`, inicia somente
com o argumento de porta e verifica que o estado do servidor registra o bind padrão
`localhost` nos seis alvos nativos. As imagens de container usam o fallback apenas de processo
`MANGOSTUDIO_DEFAULT_API_HOST=0.0.0.0`, abaixo do host explícito da CLI, de `API_HOST`, do
`.env` e do TOML. Esses caminhos de smoke qualificam contratos de bind diferentes; veja
`tests/browser-smoke/support/smoke-home.ts`, `scripts/release/smoke-binary.sh` e os dois Dockerfiles.

## Proteção de branch / checks obrigatórios

O [ruleset ativo de main](https://github.com/juliopolycarpo/mangostudio/rules/14350640)
(ID `14350640`) foi migrado e consultado em **2026-11-04**. Seus contextos
obrigatórios exatos são:

| Contexto obrigatório da API              | ID / slug da aplicação               | Produtor                                                  |
| ---------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| `CI Gate`                                | `15368` / `github-actions`           | `ci.yml`, job `gate-unique`                               |
| `Cargo Shim Gate`                        | `15368` / `github-actions`           | `cargo-shim.yml`, job `gate-unique`                       |
| `Protocol Gate`                          | `15368` / `github-actions`           | `protocol-ci.yml`, job `gate-unique`                      |
| `Release Dry Run / Release Dry Run Gate` | `15368` / `github-actions`           | `release-dry-run.yml`, job `gate-unique`, chamado pelo CI |
| `Dependency Review`                      | `15368` / `github-actions`           | `dependency-review.yml`, job `dependency-review`          |
| `CodeQL`                                 | `57789` / `github-advanced-security` | Resultados de code scanning de `codeql.yml`               |
| `Apply path-based labels`                | `15368` / `github-actions`           | `labeler.yml`, job `label`                                |

`Verify classification labels` é um step de `Apply path-based labels`, não um
contexto obrigatório. Os quatro agregados únicos foram verificados antes de
substituir a exigência ambígua de `Gate`. IDs das aplicações, política de status
estrito, condições, bypass actors e todas as outras regras foram preservados.

Os [recibos e histórico da transição](../../reference/ci-gates.md) preservam o
inventário anterior e a evidência da migração. Não substitua um contexto
obrigatório verificado por jobs internos, células de matrix ou contextos
previstos de reusable workflows. Alterar o ruleset é uma operação separada de
settings do GitHub; publicação continua limitada a tags e pushes em `main`.

### Branches temporárias de integração

Use uma base sob `stack/**` para pull requests dependentes. CI, Cargo Shim,
Protocol CI, CodeQL e Dependency Review aceitam `main` e `stack/**` em
`pull_request`; os gatilhos de push continuam exclusivos de `main`. Um PR da
pilha recebe validação sem ganhar caminho de publicação nem um segundo run
de push na branch de desenvolvimento.

Mantenha nomes de branches avulsas fora dos filtros e suas asserções.
Siga o [procedimento de PRs empilhados](../../reference/ci-gates.md#stacked-pull-requests)
para restacking, troca de base e validação antes de integrar em `main`.

## Relacionado

- Decisões e limites das medições: [`ci-optimization-evidence.md`](../../reference/ci-optimization-evidence.md)
- Pipeline de release e dry-run: [`releasing.md`](./releasing.md)
- Gates locais de QA e taxonomia de testes: [`testing.md`](./testing.md)
- Avaliador do gate: `scripts/ci/evaluate-gate.ts`
