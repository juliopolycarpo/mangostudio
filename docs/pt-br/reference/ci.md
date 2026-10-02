# Integração Contínua

Como o MangoStudio faz o gate de merges em `main` e na branch temporária
`feat/rust-runtime`, e quais checks do GitHub são seguros para exigir no ruleset.

## Gates agregados

Cada workflow com gate termina com um job always-reporting chamado `Gate`. Esse
job declara `needs` em toda lane obrigatória, roda com `if: always()` e avalia
os resultados das dependências via `scripts/ci/evaluate-gate.ts`. A proteção de
branch e o Canary dependem desses nomes estáveis em vez de acompanhar nomes
internos de jobs, formatos de matrix ou path filters.

| Nome do check            | Workflow                                | Papel                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI / Gate`              | `.github/workflows/ci.yml`              | Correção obrigatória de PR / `main`; o Canary também depende deste gate; aceita o skip de `rust-coverage` quando nenhum caminho relevante para Rust mudou                                                           |
| `Cargo Shim / Gate`      | `.github/workflows/cargo-shim.yml`      | Nome legado estável do workspace Rust; cobre o build nas três plataformas, o teste simples no macOS e no Windows (o do Linux é o `Rust Coverage` do `CI / Gate`), MSRV do launcher e resolução do workspace de fuzz |
| `Release Dry Run / Gate` | `.github/workflows/release-dry-run.yml` | Sempre reporta; aceita o skip de cada lane de dry-run quando irrelevante                                                                                                                                            |

Os testes em `scripts/tests/ci-gate.unit.test.ts` derivam o `needs` esperado de
cada gate a partir do texto do workflow: todo job exceto o próprio gate e
qualquer job que já dependa do gate. Adicionar uma lane obrigatória sem
conectá-la ao gate falha o teste.

## Dependências Rust resolvidas do zero

O `rust-fresh-dependencies.yml` resolve um novo lockfile Cargo da raiz toda terça
e em execuções manuais. Roda a política de dependências e build, clippy, testes do
workspace e doctests no Linux, macOS e Windows com o mesmo grafo. Falhas de
política não pulam os checks de plataforma. Os pins exatos do SDK continuam exatos. O
lock resolvido fica como artefato do workflow e nunca é commitado. Esse workflow
informativo não alimenta um gate obrigatório de PR. Falhas agendadas ou manuais
atualizam uma única issue do bot, preservando notas dos mantenedores; a validação
do workflow em PRs nunca escreve issues. O CI com lock e o Dependabot continuam
independentes.

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
`feat/rust-runtime` devem ser os três gates estáveis acima, mais os checks
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
