# Integração Contínua

Como o MangoStudio faz o gate de merges em `main` e na branch temporária
`feat/rust-runtime`, e quais checks do GitHub são seguros para exigir no ruleset.

## Gates agregados

Cada workflow com gate termina com um job always-reporting chamado `Gate`. Esse
job declara `needs` em toda lane obrigatória, roda com `if: always()` e avalia
os resultados das dependências via `scripts/ci/evaluate-gate.ts`. A proteção de
branch e o Canary dependem desses nomes estáveis em vez de acompanhar nomes
internos de jobs, formatos de matrix ou path filters.

| Nome do check            | Workflow                                | Papel                                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI / Gate`              | `.github/workflows/ci.yml`              | Correção obrigatória de PR / `main`; o Canary também depende deste gate; aceita o skip de `rust-coverage` quando nenhum caminho relevante para Rust mudou                                                                                      |
| `Cargo Shim / Gate`      | `.github/workflows/cargo-shim.yml`      | Nome legado estável do workspace Rust; cobre o build nas três plataformas, o teste simples no macOS e no Windows (o do Linux é o `Rust Coverage` do `CI / Gate`), as checagens de Rust mínimo (veja abaixo) e a resolução do workspace de fuzz |
| `Protocol CI / Gate`     | `.github/workflows/protocol-ci.yml`     | Sempre reporta; aceita o skip de cada lane do protocolo quando nenhum caminho do protocolo mudou                                                                                                                                               |
| `Release Dry Run / Gate` | `.github/workflows/release-dry-run.yml` | Sempre reporta; aceita o skip de cada lane de dry-run quando irrelevante                                                                                                                                                                       |

As regras do repositório casam os checks obrigatórios pelo nome `Gate`, e os
quatro workflows acima emitem um check com esse nome; cada um precisa continuar
reportando em todo pull request: sem `paths` no `pull_request` e com cada lane
condicional em `ALLOWED_SKIPS` somente sob a sua própria prova de relevância.

Os testes em `scripts/tests/ci-gate.unit.test.ts` derivam o `needs` esperado de
cada gate a partir do texto do workflow: todo job exceto o próprio gate e
qualquer job que já dependa do gate. Adicionar uma lane obrigatória sem
conectá-la ao gate falha o teste.

## Rust mínimo suportado

As checagens de Rust mínimo ficam no Cargo Shim, no mesmo sinal de mudança Rust
(`RUST_WORKSPACE_PATHS` em `scripts/lib/rust-lanes.ts`) das demais lanes Rust:
uma mudança só no runtime as executa e uma mudança só de docs as pula, com o
`Gate` reportando do mesmo jeito. O Protocol CI não as repete: o sinal dele cobre
apenas caminhos do protocolo, e todo caminho de que o crate de protocolo depende
também é um caminho Rust. Cada lane escolhe a toolchain com `RUSTUP_TOOLCHAIN` no
nível do job, que prevalece sobre o `rust-toolchain.toml` (1.99.0) em todos os
passos.

| Lane             | Toolchain | Executa                                                                                                                                                                            |
| ---------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-msrv` | 1.97.0    | Linux: `cargo check --workspace --locked` e depois `--workspace --all-targets --all-features --locked`                                                                             |
| `target-msrv`    | 1.97.0    | `cargo check --workspace --all-targets --all-features --locked --target <t>` para `aarch64-apple-darwin`, `x86_64-pc-windows-msvc` e `aarch64-pc-windows-msvc`, em runners nativos |
| `launcher-msrv`  | 1.96.0    | `cargo check`, `clippy` e `test` do launcher `mangostudio`, cujo piso publicado é menor                                                                                            |

O piso do workspace é o `rust-version` do `Cargo.toml` raiz;
`scripts/tests/ci-gate.unit.test.ts` falha quando a toolchain de uma lane diverge
dele. O `target-msrv` existe porque o código `cfg(windows)` e
`cfg(target_os = "macos")` não é compilado no Linux, e os testes nativos do
`workspace` rodam na 1.99.0, então nada dizem sobre o piso. Ele só verifica
(`check`): compilar todo tipo de alvo é toda a afirmação de versão mínima. O musl
mantém a própria lane de clippy na 1.99.0 e não é alvo de Rust mínimo.

O Windows ARM64 também tem testes nativos: o `workspace-windows-arm64` roda
`cargo test -p mangostudio-runtime --all-targets --all-features --locked` em
`windows-11-arm` sob o mesmo sinal Rust, porque a distribuição apenas compila esse
alvo de forma cruzada e o smoke apenas inicia o binário gerado. Ele cobre só o
pacote do runtime (os crates de protocolo e de contrato são neutros quanto à
arquitetura e já são testados em x64) e alimenta o único `Cargo Shim / Gate`.

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
quando ele foi produzido. O resultado de `fresh` cobre os três sistemas
operacionais juntos. O grafo é construído e testado com a toolchain de
desenvolvimento fixada (1.99.0) e unificação de features em todo o workspace
(`--workspace --all-features`): nada diz sobre o piso 1.97 nem sobre o conjunto
de features de um crate isolado, que as lanes de Rust mínimo verificam apenas no
lock commitado.

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

Os checks obrigatórios em `main` e, durante a migração Rust, em
`feat/rust-runtime` devem ser os checks `Gate` estáveis acima, mais os checks
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

Publicação continua limitada a tags e pushes em `main`; PRs para
`feat/rust-runtime` executam checks sem ganhar um caminho de publicação.

## Relacionado

- Pipeline de release e dry-run: [`releasing.md`](./releasing.md)
- Gates locais de QA e taxonomia de testes: [`testing.md`](./testing.md)
- Avaliador do gate: `scripts/ci/evaluate-gate.ts`
