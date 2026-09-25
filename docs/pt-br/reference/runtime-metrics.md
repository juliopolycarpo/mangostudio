# Métricas Do Runtime

Números de tamanho, tempo de build e volume de código do `mangostudio-runtime` construído com
cargo, registrados quando o runtime TypeScript foi aposentado e todos os alvos de distribuição
passaram a entregar o binário Rust. São uma linha de base para mudanças futuras, não um limite
que o CI impõe. Meça de novo com os comandos abaixo em vez de editar os números à mão.

## Perfil de release

O `[profile.release]` do workspace, no `Cargo.toml` da raiz, define `opt-level = 3`,
`lto = "fat"`, `codegen-units = 1`, `strip = true` e `panic = "unwind"`. O unwind é
obrigatório: o isolamento de panics dos handlers captura o unwind, então o crate do runtime se
recusa a compilar com uma estratégia de panic que aborta.

Comparação local em linux-x64 (`cargo build --release --locked -p mangostudio-runtime`, rebuild
completo a cada vez numa máquina compartilhada de 28 threads com `CARGO_BUILD_JOBS=8`; leia os
tempos como relativos):

| Perfil                                   | Tempo de build | Tamanho sem símbolos | vs. padrão |
| ---------------------------------------- | -------------: | -------------------: | ---------: |
| padrão do cargo (LTO thin-local, 16 CGU) |          178 s |             34,08 MB |          — |
| `lto = "thin"`, 1 CGU, strip             |          396 s |             28,89 MB |     −15,2% |
| `lto = "fat"`, 1 CGU, strip (o entregue) |          588 s |             26,26 MB |     −22,9% |

O LTO fat custa cerca de 50% a mais de build que o thin por mais 9% de tamanho. O runtime é
construído uma vez por alvo de release no CI, então o download menor vence.

## Tamanho do binário por alvo

Artefatos do `runtime-build.yml`, descompactados. Antes: CI no head `72172b38` de
`feat/rust-runtime` (merge ref `4be9c25e`, perfil de release padrão do cargo). Depois: CI com
este perfil, fonte `b2ee0c77` (merge ref `a400be5e`). Os tempos de build são as durações dos
jobs do `runtime-build.yml` nessas execuções, em runners compartilhados do GitHub.

| Plataforma         | Antes (bytes) | Depois (bytes) | Variação | Build no CI antes | Build no CI depois |
| ------------------ | ------------: | -------------: | -------: | ----------------: | -----------------: |
| `linux-x64`        |    33.810.720 |     26.022.592 |   −23,0% |             4m21s |              7m01s |
| `linux-arm64`      |    30.824.608 |     22.709.960 |   −26,3% |             5m04s |              6m07s |
| `linux-x64-musl`   |    32.847.992 |     25.519.248 |   −22,3% |             3m23s |              5m58s |
| `linux-arm64-musl` |    29.967.520 |     22.208.256 |   −25,9% |             5m06s |              6m58s |
| `darwin-x64`       |    41.598.856 |     24.483.648 |   −41,1% |             5m46s |              9m48s |
| `darwin-arm64`     |    40.541.120 |     22.275.376 |   −45,1% |             8m23s |             11m19s |
| `windows-x64`      |    40.247.296 |     33.669.120 |   −16,3% |             9m15s |             12m41s |
| `windows-arm64`    |    33.764.352 |     28.660.224 |   −15,1% |            10m33s |             14m08s |
| **as 8**           |   283.602.464 |    205.548.424 |   −27,5% |                   |                    |

Os alvos Linux já saíam sem símbolos antes (o linker do zig os descarta), então a variação
deles vem só do LTO e da codegen unit única. Os binários darwin encolhem mais porque o perfil
padrão deixava a tabela de símbolos neles (cerca de 88.000 símbolos, contra 251 agora). Um
executável Windows não tem tabela de símbolos para remover, então a variação dele é só do LTO. O build com LTO fat acrescenta de
1 a 4 minutos por alvo, bem dentro do timeout de 30 minutos do job.

## Do que o binário linux-x64 é feito

`CARGO_PROFILE_RELEASE_STRIP=false cargo bloat --release --locked -p mangostudio-runtime --bin mangostudio-runtime --crates -n 20`
com o perfil entregue. A seção `.text` tem 18,8 MiB de um arquivo de 34,3 MiB com símbolos; a
atribuição sob LTO fat é aproximada.

| Crate                   | Fatia de `.text` |   Tamanho |
| ----------------------- | ---------------: | --------: |
| `mangostudio_runtime`   |            15,8% |   3,0 MiB |
| `std`                   |            13,5% |   2,5 MiB |
| `jsonschema`            |            12,9% |   2,4 MiB |
| `tokio`                 |             7,4% |   1,4 MiB |
| `serde_core`            |             4,7% | 912,9 KiB |
| não atribuído           |             4,6% | 891,3 KiB |
| `rmcp`                  |             4,1% | 795,1 KiB |
| `mango_protocol`        |             3,6% | 701,3 KiB |
| `serde_json`            |             3,6% | 691,4 KiB |
| `mango_agent_codex`     |             3,5% | 667,8 KiB |
| `mango_agent_acp`       |             2,4% | 467,5 KiB |
| `mango_external_agents` |             2,1% | 394,4 KiB |
| `rustls`                |             2,0% | 381,8 KiB |
| mais 109 crates         |            18,8% |   3,5 MiB |

`cargo machete` e `cargo +nightly udeps --workspace --all-targets --all-features` não apontam
dependência sem uso, e o `tokio` habilita só as features que o runtime chama.

## Volume de código da migração para Rust

`git diff -M50% --numstat origin/main...b2ee0c77`, classificado por caminho:

- **docs**: `docs/**` e qualquer `*.md`.
- **generated**: caminhos sob `generated/`, `Cargo.lock`, `bun.lock`.
- **tests**: diretórios `tests/`, `fixtures/`, `examples/`, `fuzz/`, `*.test.ts(x)` e os
  arquivos Rust `tests.rs`/`*_tests.rs`/`testing.rs`. **Rust (inline modules)** conta as linhas
  dos blocos `#[cfg(test)] mod … { }` dentro de arquivos Rust e as tira de production.
- **production**: todo o resto. TypeScript quer dizer `.ts`/`.tsx`/`.js`; other quer dizer JSON,
  YAML, TOML, shell e o resto.

| Tipo           | Linguagem             | Arquivos | Adicionadas | Removidas | Líquido |
| -------------- | --------------------- | -------: | ----------: | --------: | ------: |
| production     | TypeScript            |      889 |       5,596 |    40,556 | −34,960 |
| production     | Rust                  |      179 |      64,079 |        25 | +64,054 |
| production     | other                 |       39 |         882 |       469 |    +413 |
| tests          | TypeScript            |      268 |      19,721 |    29,215 |  −9,494 |
| tests          | Rust (test files)     |       49 |      23,072 |        16 | +23,056 |
| tests          | Rust (inline modules) |      131 |      32,637 |         0 | +32,637 |
| tests          | other                 |       20 |       4,401 |       177 |  +4,224 |
| docs           | Markdown              |       39 |       1,683 |       480 |  +1,203 |
| generated      | other                 |        8 |      25,217 |       245 | +24,972 |
| **production** | todas                 |          |      70,557 |    41,050 | +29,507 |
| **tests**      | todas                 |          |      79,831 |    29,408 | +50,423 |
| **docs**       | todas                 |          |       1,683 |       480 |  +1,203 |
| **generated**  | todas                 |          |      25,217 |       245 | +24,972 |

A linha de módulos inline reconta linhas de arquivos Rust de production, então sua contagem de
arquivos se sobrepõe à linha de Rust em production; as linhas dela são subtraídas lá. Um arquivo
binário não é contado.

A remoção do runtime TypeScript é a maior parte das deleções de TypeScript em production; o
comportamento dele foi para as linhas de Rust em production, e a cobertura de compatibilidade
para testes Rust e fixtures congeladas.

## Como medir de novo

- Tamanhos: baixe os artefatos `runtime-<sha>-<platform>` de uma execução de CI
  (`gh run download <run-id> -p 'runtime-*'`) e compare os tamanhos.
- Composição: o comando `cargo bloat` acima, em Linux x64.
- Volume de código: o `git diff` acima contra o `origin/main` atual.
