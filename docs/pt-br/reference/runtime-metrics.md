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

Medido de novo em 2026-09-29 em `02aca80f`, no mesmo tipo de máquina, agora com todos os núcleos
(`CARGO_BUILD_JOBS` sem valor), um diretório de target limpo por build e três builds intercalados
por perfil (medianas):

| Perfil                                   | Tempo de build | CPU de usuário | Tamanho sem símbolos | Pico de RSS do runtime (Δ vs fat) |
| ---------------------------------------- | -------------: | -------------: | -------------------: | --------------------------------: |
| `lto = "thin"`, 1 CGU, strip             |          360 s |         1155 s |             28,91 MB |                           +~3 MiB |
| `lto = "fat"`, 1 CGU, strip (o entregue) |          491 s |         1045 s |             26,28 MB |                                 — |

O thin ainda faz o build cerca de 27% mais rápido em tempo real (gasta mais CPU no total, espalhada
por mais geração de código em paralelo), mas entrega um binário 10% maior e soma cerca de
3 MiB ao pico de RSS de cada processo do runtime, sem diferença mensurável de latência. O fat fica:
builds de release são jobs raros de CI, enquanto tamanho e memória chegam a toda instalação.

## Tamanho do binário por alvo

Artefatos do `runtime-build.yml`, descompactados, os dois construídos sobre a mesma fonte de
`feat/rust-runtime` (`520a5bea`). Antes: a execução de CI 36205909878 da própria branch, com o
perfil de release padrão do cargo. Depois: a execução de CI 36205927848 deste perfil sobre ela
(head `97c53736`, merge ref `877d447c`). Os tempos de build são as durações dos jobs do
`runtime-build.yml` nessas execuções, em runners compartilhados do GitHub.

| Plataforma         | Antes (bytes) | Depois (bytes) | Variação | Build no CI antes | Build no CI depois |
| ------------------ | ------------: | -------------: | -------: | ----------------: | -----------------: |
| `linux-x64`        |    33.817.680 |     26.031.832 |   −23,0% |             4m46s |              7m17s |
| `linux-arm64`      |    30.815.272 |     22.716.960 |   −26,3% |             3m43s |              7m22s |
| `linux-x64-musl`   |    32.848.976 |     25.528.488 |   −22,3% |             4m46s |              5m17s |
| `linux-arm64-musl` |    29.962.288 |     22.215.192 |   −25,9% |             5m01s |              6m38s |
| `darwin-x64`       |    41.646.136 |     24.491.872 |   −41,2% |             5m50s |             11m16s |
| `darwin-arm64`     |    40.625.104 |     22.291.904 |   −45,1% |             6m04s |              9m27s |
| `windows-x64`      |    40.036.352 |     33.679.872 |   −15,9% |             9m27s |             12m23s |
| `windows-arm64`    |    33.780.736 |     28.668.928 |   −15,1% |             9m50s |             13m41s |
| **as 8**           |   283.532.544 |    205.625.048 |   −27,5% |                   |                    |

Os alvos Linux já saíam sem símbolos antes (o linker do zig os descarta), então a variação
deles vem só do LTO e da codegen unit única. Os binários darwin encolhem mais porque o perfil
padrão deixava a tabela de símbolos neles (cerca de 88.000 símbolos, contra 251 agora). Um
executável Windows não tem tabela de símbolos para remover, então a variação dele é só do LTO.
O build com LTO fat acrescenta de meio minuto a cinco minutos e meio por alvo, bem dentro do
timeout de 30 minutos do job.

## Do que o binário linux-x64 é feito

`CARGO_PROFILE_RELEASE_STRIP=false cargo bloat --release --locked -p mangostudio-runtime --bin mangostudio-runtime --crates -n 20`
com o perfil entregue, na fonte do runtime em `72172b38`. A seção `.text` tem 18,8 MiB de um
arquivo de 34,3 MiB com símbolos; a atribuição sob LTO fat é aproximada.

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

`git diff -M50% --numstat origin/main...46785f6f` (o topo de `feat/rust-runtime` sobre o qual
esta linha de base foi registrada), classificado por caminho:

- **docs**: `docs/**` e qualquer `*.md`.
- **generated**: caminhos sob `generated/`, `Cargo.lock`, `bun.lock`.
- **tests**: diretórios `tests/`, `fixtures/`, `examples/`, `fuzz/`, `*.test.ts(x)` e os
  arquivos Rust `tests.rs`/`*_tests.rs`/`testing.rs`. **Rust (inline modules)** conta as linhas
  dos blocos `#[cfg(test)] mod … { }` dentro de arquivos Rust e as tira de production.
- **production**: todo o resto. TypeScript quer dizer `.ts`/`.tsx`/`.js`; other quer dizer JSON,
  YAML, TOML, shell e o resto.

| Tipo           | Linguagem             | Arquivos | Adicionadas | Removidas | Líquido |
| -------------- | --------------------- | -------: | ----------: | --------: | ------: |
| production     | TypeScript            |      891 |       5.791 |    40.631 | −34.840 |
| production     | Rust                  |      182 |      65.338 |        25 | +65.313 |
| production     | other                 |       39 |         918 |       456 |    +462 |
| tests          | TypeScript            |      270 |      19.939 |    29.216 |  −9.277 |
| tests          | Rust (test files)     |       50 |      23.545 |        16 | +23.529 |
| tests          | Rust (inline modules) |      134 |      34.067 |         0 | +34.067 |
| tests          | other                 |       20 |       4.401 |       177 |  +4.224 |
| docs           | Markdown              |       40 |       1.847 |       494 |  +1.353 |
| generated      | other                 |        8 |      25.217 |       245 | +24.972 |
| **production** | todas                 |          |      72.047 |    41.112 | +30.935 |
| **tests**      | todas                 |          |      81.952 |    29.409 | +52.543 |
| **docs**       | todas                 |          |       1.847 |       494 |  +1.353 |
| **generated**  | todas                 |          |      25.217 |       245 | +24.972 |

A linha de módulos inline reconta linhas de arquivos Rust de production, então sua contagem de
arquivos se sobrepõe à linha de Rust em production; as linhas dela são subtraídas lá. Um arquivo
binário não é contado.

A remoção do runtime TypeScript é a maior parte das deleções de TypeScript em production; o
comportamento dele foi para as linhas de Rust em production, e a cobertura de compatibilidade
para testes Rust e fixtures congeladas.

## Binário do hub: bytecode

O hub não é um build do cargo, mas é distribuído ao lado do runtime, então seu tempo de
inicialização e tamanho também ficam registrados aqui. O `scripts/build.ts` o compila com
`--bytecode --bytecode-depth=2 --format=esm` (bytecode sozinho emite CommonJS, que rejeita o `await` de nível
superior do entry). O JSC passa a carregar bytecode pré-compilado em vez de analisar o bundle
minificado a cada inicialização.

Medido em linux-x64 com Bun 1.4.2, sobre `7d7263d6` com e sem as duas flags, ambos via
`bun run build:binary --platform linux-x64` (produção, frontend embutido). A inicialização é a
mediana de 15 execuções de `scripts/bench/startup.ts`; `--version` é a mediana de 20.

| Medida                          | Sem bytecode | Com bytecode | Variação |
| ------------------------------- | -----------: | -----------: | -------: |
| `--version`                     |       427 ms |       148 ms |     −65% |
| Início a frio → `/api/health`   |       908 ms |       406 ms |     −55% |
| Início a quente → `/api/health` |       803 ms |       356 ms |     −56% |
| Pico de RSS na inicialização    |       123 MB |       129 MB |      +5% |
| Tamanho do binário (bytes)      |   99,218,912 |  116,930,016 |     +18% |

Todos os alvos crescem os mesmos ~17,7 MB de bytecode (`bun build --compile` do mesmo entry
embutido para os outros sete alvos). O `.map` externo mantém o formato, e os stack traces
continuam apontando para as linhas do código original.

### Profundidade do bytecode

`--bytecode-depth=2` é um ajuste de tamanho do pacote, não de velocidade. O padrão do Bun compila
antecipadamente todos os níveis de funções aninhadas; a profundidade 2 compila o código de nível
superior de cada módulo, as funções que ele declara e as funções que essas declaram, e deixa o
que está mais fundo para ser compilado a partir do código-fonte na primeira vez que executa. A
tabela acima foi medida na profundidade padrão.

A profundidade está em `binaryCompileFlags` (`scripts/lib/build.ts`) e é fixada por
`scripts/tests/build.unit.test.ts`, que também compila um fixture com funções muito aninhadas com
e sem a flag: o Bun aceita `--bytecode-depth` escrito errado sem reclamar e compila na profundidade
padrão, então o array de flags sozinho não prova que o ajuste teve efeito.

| Medida (linux-x64, Bun 1.4.2, `ee3075b6` mais esta mudança, n=1) | Profundidade padrão | Profundidade 2 |   Variação |
| ---------------------------------------------------------------- | ------------------: | -------------: | ---------: |
| Executável do hub (bytes)                                        |         117,040,608 |    114,173,408 | −2,867,200 |

O tamanho do executável é uma contagem de bytes determinística. O arquivo é comprimido, então encolhe
menos (1.329.177 bytes com um runtime cargo de debug), e o percentual depende do runtime dentro
dele: meça com o runtime de release (`--runtime-dir`). Nenhuma afirmação de inicialização é feita para a
profundidade 2: compare com o padrão usando `scripts/bench/startup.ts` em um host quieto, já que o
código que deixa de ser pré-compilado é código analisado no primeiro uso.

## Como medir de novo

- Tamanhos: baixe os artefatos `runtime-<sha>-<platform>` de uma execução de CI
  (`gh run download <run-id> -p 'runtime-*'`) e compare os tamanhos.
- Composição: o comando `cargo bloat` acima, em Linux x64.
- Volume de código: o `git diff` acima contra o `origin/main` atual.
- Inicialização do hub: `bun run scripts/bench/startup.ts .mango/out/linux-x64/mangostudio --runs 15`
  (com `--warm` para um reinício) contra binários com e sem as flags.
