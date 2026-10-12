# Integração Contínua

Como o MangoStudio faz o gate de merges em `main`, e quais checks do GitHub são seguros para
exigir no ruleset.

## Gates agregados

Cada workflow com gate termina com um job always-reporting chamado `Gate`. Esse
job declara `needs` em toda lane obrigatória, roda com `if: always()` e avalia
os resultados das dependências via `scripts/ci/evaluate-gate.ts`. A proteção de
branch e o Canary dependem desses nomes estáveis em vez de acompanhar nomes
internos de jobs, formatos de matrix ou path filters.

| Nome do check            | Workflow                                | Papel                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI / Gate`              | `.github/workflows/ci.yml`              | Correção obrigatória de PR / `main`; o Canary também depende deste gate; aceita o skip de `rust-coverage` quando nenhum caminho relevante para Rust mudou                                                                                |
| `Cargo Shim / Gate`      | `.github/workflows/cargo-shim.yml`      | Nome legado estável do workspace Rust; cobre checks e builds com lock no Rust mínimo 1.99.0 em Linux, macOS e Windows, testes nativos em macOS e Windows, checks e testes do runtime em Windows ARM64 e a resolução do workspace de fuzz |
| `Protocol CI / Gate`     | `.github/workflows/protocol-ci.yml`     | Sempre reporta; aceita o skip de cada lane do protocolo quando nenhum caminho do protocolo mudou                                                                                                                                         |
| `Release Dry Run / Gate` | `.github/workflows/release-dry-run.yml` | Sempre reporta; aceita o skip de cada lane de dry-run quando irrelevante                                                                                                                                                                 |

As regras do repositório casam os checks obrigatórios pelo nome `Gate`, e os
quatro workflows acima emitem um check com esse nome; cada um precisa continuar
reportando em todo pull request: sem `paths` no `pull_request` e com cada lane
condicional em `ALLOWED_SKIPS` somente sob a sua própria prova de relevância.

Os testes em `scripts/tests/ci-gate.unit.test.ts` derivam o `needs` esperado de
cada gate a partir do texto do workflow: todo job exceto o próprio gate e
qualquer job que já dependa do gate. Adicionar uma lane obrigatória sem
conectá-la ao gate falha o teste.

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
depois da mudança e alimentam `Cargo Shim / Gate`. `crates/**` seleciona mudanças só no runtime,
e `spec/**` e os demais arquivos lidos pelos crates selecionam mudanças do protocolo. Pull
requests sem um caminho Rust correspondente pulam os jobs sob a prova de relevância do gate,
que continua reportando. Pushes selecionados pelo filtro do workflow e dispatches manuais
executam os jobs Rust. O Protocol CI mantém seu sinal próprio do protocolo e não repete esses
checks de versão mínima.

Isso remove cinco instâncias de jobs Rust: um `workspace-msrv`, três pernas da matrix
`target-msrv` e um `launcher-msrv`. Encerra o suporte aos compiladores antigos e mantém a
cobertura de comandos, features e plataformas no novo mínimo. Esta mudança não apresenta
medição de redução de tempo ou de tamanho do cache.

As validações independentes e a preparação de Bun/nextest usam `!cancelled()` para que um check
com falha não impeça os outros checks ou os testes nativos. Cada falha ainda reprova o job e o
gate agregado.

Os checks existentes continuam:

| Lane e gate agregado                           | Comando e escopo de pacote/features                                                                                                               | Cobertura de runners                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `workspace`, `Cargo Shim / Gate`               | `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`; `cargo build --workspace --locked` | Linux x64, macOS arm64 e Windows x64 nativos                                                                           |
| `workspace`, `Cargo Shim / Gate`               | `cargo nextest run --workspace --all-targets --all-features --locked --retries 0`; paridade do inventário nextest/libtest                         | macOS arm64 e Windows x64 nativos; a paridade também roda em Linux x64                                                 |
| `rust-coverage`, `CI / Gate`                   | `cargo llvm-cov --no-report --workspace --all-targets --all-features --locked`, libtest instrumentado                                             | Linux x64 nativo, mesmo sinal de caminhos Rust                                                                         |
| `workspace`, `Cargo Shim / Gate`               | `cargo test --doc --workspace --all-features --locked`; `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --workspace --all-features --locked`      | Linux x64; os doctests e docs específicos do protocolo em macOS/Windows continuam no Protocol CI                       |
| `workspace-windows-arm64`, `Cargo Shim / Gate` | `cargo nextest run -p mangostudio-runtime --all-targets --all-features --locked --retries 0`                                                      | Windows ARM64 nativo, `windows-11-arm`, mesmo sinal de caminhos Rust                                                   |
| `musl-clippy`, `Cargo Shim / Gate`             | `cargo-zigbuild clippy --locked -p mangostudio-runtime --all-targets --target <t> -- -D warnings`: runtime, features padrão                       | Checks cruzados em Linux para `x86_64-unknown-linux-musl` e `aarch64-unknown-linux-musl`, mesmo sinal de caminhos Rust |
| Protocol CI, `Protocol CI / Gate`              | Powerset de features do protocolo, interop, igualdade de schemas, semver e checks do pacote publicado                                             | Sinal existente de caminhos do protocolo e cobertura Linux/macOS/Windows                                               |

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
todo envelope da `main` seja um baseline Rust); o `CI / Gate` só aceita o skip
sob essa prova. Doctests, o run `--ignored` e a qualificação do binário real
ficam no Cargo Shim, sem instrumentação. Lane pulada por irrelevância deixa os
crates `unsupported` (não é lacuna); job devido que não entregou nada é
`unavailable`; teste com falha é `partial`; crate sem dados de profile é
`unavailable`, nunca 0%.

## Proteção de branch / checks obrigatórios

Os checks obrigatórios em `main` devem ser os checks `Gate` estáveis acima, mais os checks
independentes de segurança / processo que não entram nesses gates:

- `CI / Gate`
- `Cargo Shim / Gate`
- `Release Dry Run / Gate`
- CodeQL
- Dependency review
- Verify classification labels

**Não** exija nomes internos de jobs, nomes de jobs de reusable workflows ou
nomes de checks de matrix (por exemplo `Check`, `Test`, `Build` ou uma célula
de smoke). Esses nomes mudam conforme os workflows evoluem; os testes de gate já
garantem que toda lane obrigatória alimenta um gate.

Atualizar o ruleset do repositório é uma operação de settings do GitHub, não um
commit. Depois de mudar quais checks são obrigatórios, mantenha esta seção
alinhada.

Publicação continua limitada a tags e pushes em `main`.

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
