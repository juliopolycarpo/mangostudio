# Integração Contínua

Como o MangoStudio faz o gate de merges em `main`, e quais checks do GitHub são
seguros para exigir na proteção de branch.

## Gates agregados

Cada workflow com gate termina com um job always-reporting chamado `Gate`. Esse
job declara `needs` em toda lane obrigatória, roda com `if: always()` e avalia
os resultados das dependências via `scripts/ci/evaluate-gate.ts`. A proteção de
branch e o Canary dependem desses nomes estáveis em vez de acompanhar nomes
internos de jobs, formatos de matrix ou path filters.

| Nome do check            | Workflow                                | Papel                                                                    |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------ |
| `CI / Gate`              | `.github/workflows/ci.yml`              | Correção obrigatória de PR / `main`; o Canary também depende deste gate  |
| `Cargo Shim / Gate`      | `.github/workflows/cargo-shim.yml`      | Sempre reporta; aceita o skip da lane Rust quando nenhum path Rust mudou |
| `Release Dry Run / Gate` | `.github/workflows/release-dry-run.yml` | Sempre reporta; aceita o skip de cada lane de dry-run quando irrelevante |

Os testes em `scripts/tests/ci-gate.unit.test.ts` derivam o `needs` esperado de
cada gate a partir do texto do workflow: todo job exceto o próprio gate e
qualquer job que já dependa do gate. Adicionar uma lane obrigatória sem
conectá-la ao gate falha o teste.

## Proteção de branch / checks obrigatórios

Os checks obrigatórios em `main` devem ser os três gates estáveis acima, mais os
checks independentes de segurança / processo que não entram nesses gates:

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

## Relacionado

- Pipeline de release e dry-run: [`releasing.md`](./releasing.md)
- Gates locais de QA e taxonomia de testes: [`testing.md`](./testing.md)
- Avaliador do gate: `scripts/ci/evaluate-gate.ts`
