# Integração Contínua

Como o MangoStudio faz o gate de merges em `main`, e quais checks do GitHub são seguros para
exigir no ruleset.

## Gates agregados

Cada workflow com gate reporta um job legado chamado `Gate` e um job adicional com nome
único. Ambos declaram todas as lanes obrigatórias em `needs`, rodam com `if: always()` e
avaliam as dependências via `scripts/ci/evaluate-gate.ts`. O Canary ainda depende do job
legado do CI. Nome de workflow, ID de job, rótulo de step e contexto de check da API são
identificadores diferentes:

| Workflow                                                   | ID do job legado / contexto da API em PRs | Contexto adicional da API em PRs         | Skips aceitos                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CI` (`ci.yml`)                                            | `gate` / `Gate`                           | `CI Gate`                                | Distribution, smoke de binário e smoke de container somente quando a relevância da distribuição é exatamente `false`; cobertura Rust somente quando a relevância Rust é exatamente `false`; QA em dispatch manual; dry run exclusivo de PR em outros eventos |
| `Cargo Shim` (`cargo-shim.yml`)                            | `gate` / `Gate`                           | `Cargo Shim Gate`                        | Cada lane Rust somente sob sua própria prova de relevância por caminhos                                                                                                                                                                                      |
| `Protocol CI` (`protocol-ci.yml`)                          | `gate` / `Gate`                           | `Protocol Gate`                          | Todas as lanes do protocolo somente quando nenhum caminho do protocolo mudou                                                                                                                                                                                 |
| `Release Dry Run` (`release-dry-run.yml`), chamado pelo CI | `gate` / `Release Dry Run / Gate`         | `Release Dry Run / Release Dry Run Gate` | Lanes de asserção irrelevantes e o produtor limpo do runtime no caminho verificado de reutilização do mesmo run de PR                                                                                                                                        |

Os jobs adicionais usam o ID `gate-unique`. Em prosa, “Gate do CI” identifica um produtor;
isso não significa que o contexto da API seja `CI / Gate`. Os workflows independentes CI,
Cargo Shim e Protocol CI emitem o mesmo contexto simples `Gate`. Chamadas de reusable
workflows prefixam o nome do job folha com o nome do job chamador, como no Release Dry Run
acima. Runs agendados ou manuais independentes do Release Dry Run mantêm os nomes folha
`Gate` e `Release Dry Run Gate`. O [snapshot dos checks obrigatórios](#proteção-de-branch--checks-obrigatórios)
registra o que de fato é exigido; a adoção dos contextos únicos continua proposta.

Os skips de distribuição usam uma allowlist em
[`scripts/lib/ci-lanes.ts`](../../../scripts/lib/ci-lanes.ts), não uma regra geral de que
toda mudança Markdown é irrelevante. Em PRs, o job `changes` do CI coleta um diff validado,
não vazio e com os dois lados de renames; só emite `distribution=false` se todos os caminhos
estiverem na allowlist. Essa prova permite pular os jobs `distribution`, `smoke` (binário) e
`smoke-container`. Caminhos desconhecidos os executam; pushes e dispatches manuais também.
A relevância Rust e a do protocolo são independentes. O gate rejeita resultados de
relevância ausentes, falhas, cancelamentos e skips inesperados.

Os testes em `scripts/tests/ci-gate.unit.test.ts` derivam o `needs` esperado do texto de cada
workflow; `gate-compatibility.unit.test.ts` verifica os jobs legados e adicionais. Adicionar
uma lane obrigatória sem conectá-la aos dois gates falha a validação.

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

| Antes                    | Comando e escopo de pacote/features                                                                                                                                                                             | Alvo e runner antes                                                                                   | Substituto na 1.99.0                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `workspace-msrv`, 1.97.0 | `cargo check --workspace --locked`: bibliotecas/binários do workspace, features padrão                                                                                                                          | Linux x64, `ubuntu-latest`                                                                            | `workspace` em Linux x64, macOS arm64 e Windows x64, mesmo comando                                          |
| `workspace-msrv`, 1.97.0 | `cargo check --workspace --all-targets --all-features --locked`: workspace, todo tipo de alvo e feature                                                                                                         | Linux x64, `ubuntu-latest`                                                                            | `workspace` em Linux x64, macOS arm64 e Windows x64, mesmo comando                                          |
| `target-msrv`, 1.97.0    | `cargo check --workspace --all-targets --all-features --locked --target <t>`: workspace completo                                                                                                                | `aarch64-apple-darwin` em `macos-latest`; `x86_64-pc-windows-msvc` em `windows-latest`, ambos nativos | `workspace` em cada runner nativo, mesmo escopo/features pelo alvo do host                                  |
| `target-msrv`, 1.97.0    | Mesmo check do workspace completo, `--target aarch64-pc-windows-msvc`                                                                                                                                           | Check cruzado de Windows ARM64 a partir do `windows-latest` x64                                       | `workspace-windows-arm64` no `windows-11-arm` nativo, mesmo comando e alvo explícito                        |
| `target-msrv`, 1.96.0    | `cargo check -p mangostudio --all-targets --locked --target <t>`: launcher isolado, features padrão                                                                                                             | macOS arm64 e Windows x64 nativos                                                                     | `workspace` nesses runners, `cargo check -p mangostudio --all-targets --locked`; também roda em Linux x64   |
| `target-msrv`, 1.96.0    | Mesmo check exclusivo do launcher, `--target aarch64-pc-windows-msvc`                                                                                                                                           | Check cruzado de Windows ARM64 a partir do `windows-latest` x64                                       | `workspace-windows-arm64` no `windows-11-arm` nativo, mesmo comando e alvo explícito                        |
| `launcher-msrv`, 1.96.0  | `cargo check -p mangostudio --all-targets --locked`, `cargo clippy -p mangostudio --all-targets --locked -- -D warnings`, `cargo test -p mangostudio --all-targets --locked`: launcher isolado, features padrão | Linux x64, `ubuntu-latest`                                                                            | `workspace` do Ubuntu mantém os três comandos; o check do launcher também roda em macOS arm64 e Windows x64 |

Todas as linhas usam o mesmo sinal `RUST_WORKSPACE_PATHS` em `scripts/lib/rust-lanes.ts` antes e
depois da mudança e alimentam `Gate` do Cargo Shim. `crates/**` seleciona mudanças só no runtime,
e `spec/**` e os demais arquivos lidos pelos crates selecionam mudanças do protocolo. Pull
requests sem um caminho Rust correspondente pulam os jobs sob a prova de relevância do gate,
que continua reportando. Pushes selecionados pelo filtro do workflow e dispatches manuais
executam os jobs Rust. O Protocol CI mantém seu sinal próprio do protocolo e não repete esses
checks de versão mínima.

Isso remove cinco instâncias de jobs Rust: um `workspace-msrv`, três pernas da matrix
`target-msrv` e um `launcher-msrv`. Encerra o suporte aos compiladores antigos e mantém a
cobertura de comandos, features e plataformas no novo mínimo. Esta mudança não apresenta
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

| Lane e gate agregado                            | Comando e escopo de pacote/features                                                                                                               | Cobertura de runners                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `workspace`, `Gate` do Cargo Shim               | `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`; `cargo build --workspace --locked` | Linux x64, macOS arm64 e Windows x64 nativos                                                                           |
| `workspace`, `Gate` do Cargo Shim               | `cargo nextest run --workspace --all-targets --all-features --locked --retries 0`; paridade do inventário nextest/libtest                         | macOS arm64 e Windows x64 nativos; a paridade também roda em Linux x64                                                 |
| `rust-coverage`, `Gate` do CI                   | `cargo llvm-cov --no-report --workspace --all-targets --all-features --locked`, libtest instrumentado                                             | Linux x64 nativo, mesmo sinal de caminhos Rust                                                                         |
| `workspace`, `Gate` do Cargo Shim               | `cargo test --doc --workspace --all-features --locked`; `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --workspace --all-features --locked`      | Linux x64; os doctests e docs específicos do protocolo em macOS/Windows continuam no Protocol CI                       |
| `workspace-windows-arm64`, `Gate` do Cargo Shim | `cargo nextest run -p mangostudio-runtime --all-targets --all-features --locked --retries 0`                                                      | Windows ARM64 nativo, `windows-11-arm`, mesmo sinal de caminhos Rust                                                   |
| `musl-clippy`, `Gate` do Cargo Shim             | `cargo-zigbuild clippy --locked -p mangostudio-runtime --all-targets --target <t> -- -D warnings`: runtime, features padrão                       | Checks cruzados em Linux para `x86_64-unknown-linux-musl` e `aarch64-unknown-linux-musl`, mesmo sinal de caminhos Rust |
| Protocol CI, `Gate` do Protocol CI              | Powerset de features do protocolo, interop, igualdade de schemas, semver e checks do pacote publicado                                             | Sinal existente de caminhos do protocolo e cobertura Linux/macOS/Windows                                               |

O Windows ARM64 agora compila o workspace completo e o launcher isolado na 1.99.0. O comando de
testes nativos continua limitado ao runtime; compilar o workspace completo não significa
executar os testes de todos os crates nesse alvo. A resolução do workspace de fuzz, a regeneração
da fixture ignorada e a qualificação do binário real mantêm seus comandos e critérios de
relevância.

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
todo envelope da `main` seja um baseline Rust); o `Gate` do CI só aceita o skip
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
(ID `14350640`) foi consultado em **2026-10-23**. Seus contextos obrigatórios exatos são:

| Contexto obrigatório da API | ID / slug da aplicação               | Produtor                                                                          |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `Gate`                      | `15368` / `github-actions`           | Compartilhado por CI, Cargo Shim e Protocol CI; veja a tabela de produtores acima |
| `Dependency Review`         | `15368` / `github-actions`           | `dependency-review.yml`, job `dependency-review`                                  |
| `CodeQL`                    | `57789` / `github-advanced-security` | Resultados de code scanning de `codeql.yml`                                       |
| `Apply path-based labels`   | `15368` / `github-actions`           | `labeler.yml`, job `label`                                                        |

`Verify classification labels` é um step do job `Apply path-based labels`, não o contexto
obrigatório. `Release Dry Run / Gate` reporta em PRs, mas não é um contexto obrigatório
separado; os gates do CI incluem o resultado do reusable workflow. O Protocol CI contribui
para o contexto simples `Gate`, mesmo sem um nome prefixado pelo workflow no ruleset.

Exigir os nomes únicos continua proposto. Os [recibos de produtores e guia de transição](../../reference/ci-gates.md)
registram os settings consultados, os contextos adicionais observados e a matriz de casos
hospedados ainda necessária. O inventário de nomes compartilhados não prova como o GitHub
resolve nomes obrigatórios ambíguos. Não substitua um contexto obrigatório verificado por
jobs internos, células de matrix ou um contexto previsto de reusable workflow. Mudar o
ruleset é uma operação separada de settings do GitHub; publicação continua limitada a tags
e pushes em `main`.

### Branches temporárias de integração

Os workflows com gate filtram `pull_request` pela branch base, e a lista é `[main]`. Um PR para
qualquer outra branch não inicia nenhum deles. Uma branch temporária de integração liga esses
workflows adicionando o próprio nome a essas listas em um commit na própria branch, junto com
as asserções em `scripts/tests/ci-gate.unit.test.ts` e
`scripts/tests/security-workflows.unit.test.ts` que fixam as listas. Um PR desses executa checks
sem ganhar um caminho de publicação.

Remova a entrada quando a branch for aposentada. `main` não deve citar uma branch que não existe
mais.

## Relacionado

- Pipeline de release e dry-run: [`releasing.md`](./releasing.md)
- Gates locais de QA e taxonomia de testes: [`testing.md`](./testing.md)
- Avaliador do gate: `scripts/ci/evaluate-gate.ts`
