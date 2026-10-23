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
`--bytecode --format=esm` (bytecode sozinho emite CommonJS, que rejeita o `await` de nível
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

## Como medir de novo

- Tamanhos: baixe os artefatos `runtime-<sha>-<platform>` de uma execução de CI
  (`gh run download <run-id> -p 'runtime-*'`) e compare os tamanhos.
- Composição: o comando `cargo bloat` acima, em Linux x64.
- Volume de código: o `git diff` acima contra o `origin/main` atual.
- Inicialização do hub: `bun run scripts/bench/startup.ts .mango/out/linux-x64/mangostudio --runs 15`
  (com `--warm` para um reinício) contra binários com e sem as flags.

## Requalificar a linha de base atual

Os números acima pertencem às revisões registradas. Não qualificam uma nova árvore de dependências,
compilador ou artefato. O roteiro atual mantém o perfil de distribuição, sem candidato de otimização:

```bash
# Só imprime o roteiro; não compila nem inicia uma medição.
bun scripts/bench/rust-costs.ts
# Executar em um host ocioso e checkout limpo, já commitado.
bun scripts/bench/rust-costs.ts --execute --out /tmp/rust-cost-receipts \
  --attribution --startup-hub /caminho/do/hub/compilado
```

São três builds release com target vazio para runtime e launcher, dez builds sem alterações e dez
com nova versão do runtime. Os dois últimos são cargas diferentes, não uma comparação de otimização.
O roteiro usa oito jobs, dependências travadas, features padrão e target explícito
`x86_64-unknown-linux-gnu`. Targets privados ficam no worktree, em ext4. Os caches de registro,
toolchain e páginas do SO continuam aquecidos. A alocação em disco é verificada entre tentativas com
orçamento de 40 GiB para targets e artefatos, e limite de três horas para o lote. Reserve espaço extra
para um build individual. O diretório de recibos deve ser novo; tentativas anteriores não são apagadas.

Os recibos guardam revisão, selo das entradas Rust/Cargo, toolchain, árvore de todos os alvos,
metadados estáveis com features padrão/completas e árvore fuzz separada. Uma tentativa aceita precisa
terminar com sucesso, entradas inalteradas e árvore de processos vazia. Builds sem alteração não podem
recompilar unidades nem mudar o hash do binário. Uma nova versão deve recompilar uma unidade, relatar
a versão esperada, mudar o hash do executável e preservar os hashes das bibliotecas. Só o runtime tem carga de nova versão, pelo input de compilação existente `MANGOSTUDIO_RELEASE_VERSION`; o launcher usa metadados Cargo e não é restampado. O launcher downloader nunca é executado para identificar sua versão: ela vem dos metadados Cargo selados, sem instalar um hub ou acessar o estado real do usuário. Tempo decorrido (resolução de 10 ms na saída), CPU final e RSS máximo individual do GNU time
ficam separados das amostras de RSS/CPU da árvore de processos.

`--attribution` produz outro artefato, com símbolos, para `cargo bloat`. A atribuição só é qualificada
quando os hashes SHA-256 de `.text` coincidem; divergências permanecem explícitas. Um binário GNU do
host não atribui custos a outro artefato de distribuição feito com Zig. Os recibos preservam tamanho
do arquivo e das seções, metadados ELF e hashes do arquivo e do código.

`--startup-hub` executa os scripts existentes sob supervisão: dois aquecimentos identificados e vinte
amostras por modo (hello e primeira resposta health do runtime, hub com banco novo e hub com banco já
migrado). O hub precisa de seu próprio recibo de build da revisão atual. Também é possível executar:

```bash
bun scripts/bench/runtime-handshake.ts /caminho/runtime --runs 20 --warmups 2 \
  --resources --json --output runtime-readiness.json
bun scripts/bench/startup.ts /caminho/hub --runs 20 --warmups 2 \
  --resources --json --output hub-fresh-readiness.json
bun scripts/bench/startup.ts /caminho/hub --runs 20 --warmups 2 --warm \
  --resources --json --output hub-migrated-readiness.json
```

Falhas e aquecimentos ficam no recibo e uma falha interrompe o lote. Com `--output`, cada início e término é sincronizado em JSONL (`--journal` altera o caminho), e as amostras concluídas são salvas por troca atômica. Um timeout externo preserva as anteriores e identifica a tentativa interrompida. O driver sempre habilita isso; sem caminho de saída ou journal, o JSON standalone só aparece no término normal. `HOME`, `USERPROFILE` e estado da
aplicação são isolados. A prontidão HTTP exige pid, porta e início recente do próprio filho.
`--resources` usa procfs Linux e registra intervalo, unidades, ausências e censo de limpeza. O limite é o instante real de prontidão, não o fim do censo posterior. Sem observações anteriores ao limite, as métricas permanecem nulas e a amostra não é qualificada. RSS é a
maior soma simultânea observada; páginas compartilhadas contam em cada processo. Zero ticks de CPU
observados não significa custo real zero. A revisão registrada pertence ao checkout do harness; o
hash do executável precisa ser ligado ao seu recibo de build. WSL não qualifica Windows ou macOS
nativos, que continuam não medidos.

O driver trata SIGINT/SIGTERM cancelando o comando supervisionado ativo, encerrando sua árvore
verificada, registrando a tentativa interrompida e parando o lote. Timeouts externos com SIGKILL
exigem um supervisor externo: o processo morto não consegue executar sua própria limpeza.

Os comandos de metadados travados usam limite explícito de stdout de máquina: 8 MiB por linha UTF-8,
com teto de 16 MiB. Isso preserva o JSON compacto completo do Cargo sem alterar os limites padrão do
relator de texto ou do stderr. Ultrapassar o limite continua sendo erro; o stdout bruto é preservado.

A primeira tentativa de admissão, em `5e267450`, gerou metadados válidos com 329 pacotes e 1.691.503
bytes, mas a proteção genérica de texto de 1 MiB rejeitou a linha depois que o Cargo saiu com sucesso.
O lote parou antes de qualquer build, aquecimento ou tentativa de prontidão. Nenhuma amostra de tempo
ou recurso foi aceita; todas as cargas posteriores ficaram não executadas. A admissão falha permanece
registrada, e um estudo posterior recebe outro identificador e seus próprios gates de revisão,
correção e limpeza.

## Linha de base Rust controlada, 2026-10-23

A revisão medida é `6cf4602a1a98c32536b5a8b83e6a40361198f657`, com selo das entradas executáveis
`b72a43ad1883b85b9d6074f3cebc4f78fe9c4861718aa2abfee58650fe2451ae`.
Esta publicação e seu teste de política são alterações posteriores; não mudam a revisão das medições.
O estudo exclusivo em Linux ocorreu em 2026-10-23 sob WSL2, kernel
`6.18.54.1-microsoft-standard-WSL2-polycarpo`, Intel Xeon E5-2699 v3 2,30 GHz,
28 CPUs lógicas e 49.326.686.208 bytes de memória visível. Os limites de CPU/memória do cgroup
estavam indisponíveis, sem interpretação como zero ou ilimitados. Desempenho nativo de Windows/macOS
e custo de CI hospedado continuam não medidos.

Rust/Cargo eram 1.99.0 (`b940084d7` / `5f94df478`), LLVM 23.1.1, Bun 1.4.3 e cargo-bloat 0.12.1.
O grupo GNU usou `x86_64-unknown-linux-gnu`, oito jobs, features padrão e o perfil release mantido:
opt-level 3 / fat LTO / uma unidade de codegen / stripped / unwind, com `CARGO_INCREMENTAL=0`.
Os inventários travados continham 329 pacotes padrão, 331 com todas as features e 101 no fuzz
excluído. Caches de registro/toolchain foram preparados e retidos; Cargo ficou offline. Cada build
limpo usou target ext4 privado e vazio. O target 3 do runtime foi retido para alternar builds sem
alterações e com nova versão. O cache de páginas do SO permaneceu aquecido e não controlado; target,
processo ou banco novo não equivale a máquina fria.

| Entrada travada             | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Cargo.lock raiz             | `3dfa76f2a871b523de34fc7875198e0dd16279b7d511cdeab4905c1b70f9bd59` |
| Cargo.lock do fuzz excluído | `f64f889d768cf0e0c1b6e394bb1491cbd7f331a9423834ab5f3c93a70354293e` |
| bun.lock                    | `acf1b4fdd7e3e268050bc0c465cf3cab736a723685ebccf109379b69d5f5bb77` |

O hub Bun compilado H foi construído e aprovado no smoke oficial em
`d9becbeec8963097ba9a485ce101f92c43a4abef`. Seu sidecar Z é o runtime Zig/glibc-2.17 construído
separadamente (entradas Rust iguais desde `911c476c`). Aplicação, Rust, locks e entradas de build de
produção foram verificados iguais na revisão medida; os helpers de benchmark/captura mudaram após o
setup do hub. A inicialização H+Z é separada dos builds e do runtime GNU. O hub pode iniciar filhos
runtime antes do health; os descendentes observados entram na amostragem. O launcher Rust L0 foi
construído três vezes e nunca executado. Sua versão veio dos metadados Cargo selados.

### Observações de build e prontidão

A ordem foi três builds limpos do runtime, três do launcher e dez pares alternados de runtime sem
alterações/com nova versão. Os 26 passaram. Cada build sem alterações recompilou zero unidades e
preservou o hash executável; cada nova versão recompilou uma unidade, mudou o hash, manteve os hashes
não vazios das bibliotecas e devolveu exatamente `0.1.1-bench.1` até `.10`. Não existe candidato de
otimização; essas cargas diferentes não estabelecem economia relativa.

| Carga                   |  n |   Mín s | Mediana s |   p95 s |   Máx s | Amplitude s | CPU final mediana usuário/sistema s | RSS amostrado mediano da árvore MiB |
| ----------------------- | -: | ------: | --------: | ------: | ------: | ----------: | ----------------------------------: | ----------------------------------: |
| Runtime, target vazio   |  3 | 471.520 |   471.980 |       — | 473.020 |       1.500 |                    854.690 / 36.470 |                            4405.098 |
| Launcher, target vazio  |  3 |  44.350 |    44.610 |       — |  44.740 |       0.390 |                      70.170 / 5.390 |                            1254.852 |
| Runtime, sem alterações | 10 |   0.360 |     0.390 |   0.430 |   0.430 |       0.070 |                       0.235 / 0.110 |                              75.512 |
| Runtime, nova versão    | 10 | 233.110 |   234.510 | 238.750 | 238.750 |       5.640 |                     230.640 / 4.085 |                            2150.988 |

Após a atribuição não pontuada, hello/health do runtime, health do hub com banco novo e health com
banco migrado executaram dois aquecimentos retidos e vinte tentativas medidas cada. As 66 passaram;
os seis aquecimentos ficam fora dos resumos e permanecem abaixo. Hello negociado do runtime teve
mín/mediana/p95/máx/amplitude de 174,824 / 193,737 / 213,288 / 214,148 / 39,324 ms (n=20).

| Prontidão útil                   |  n |  Mín ms | Mediana ms |  p95 ms |  Máx ms | Amplitude ms | CPU amostrada mediana usuário/sistema ms | RSS amostrado mediano da árvore MiB |
| -------------------------------- | -: | ------: | ---------: | ------: | ------: | -----------: | ---------------------------------------: | ----------------------------------: |
| Runtime GNU hello + health       | 20 | 305.877 |    325.993 | 345.907 | 352.488 |       46.612 |                                 150 / 85 |                              67.033 |
| Hub + runtime Zig, banco novo    | 20 | 360.742 |    419.285 | 439.980 | 446.751 |       86.008 |                                635 / 150 |                             111.791 |
| Hub + runtime Zig, banco migrado | 20 | 286.377 |    349.174 | 358.860 | 365.151 |       78.774 |                                540 / 130 |                             109.400 |

Cada coluna tem resumo independente. Percentis usam posto mais próximo (10 de 10 ou 19 de 20);
três builds limpos não sustentam estimativa estável de cauda, portanto seu p95 foi omitido.
Tempo/CPU final dos builds vêm do GNU time, com resolução impressa de 10 ms. Seu RSS máximo por
processo permanece separado em KiB abaixo. RSS da árvore é a maior soma simultânea observada,
amostrada a cada 20 ms nos builds e 10 ms na inicialização. Procfs usou páginas de 4096 bytes e 100
ticks de CPU/s (resolução de 10 ms). Páginas compartilhadas contam em cada processo; a soma não é RAM
física exclusiva. CPU amostrada pode perder trabalho já encerrado; zero ticks observados não é custo
real zero. Ausências ficam vazias no CSV, distintas de zero. Cada tentativa de inicialização teve ao
menos 28 observações anteriores à prontidão. O exportador recalculou independentemente os resumos
de RSS/CPU/contagens a partir desses frames.

O estudo também exige zero falhas históricas de censo, mesmo quando um censo posterior permite ao
runner genérico comprovar término com `errors=[]` e escopo vazio. Essa política de admissão mais
restrita já valia na revisão medida; o predicado nomeado e a regressão novos explicitam a distinção.
A recuperação do runner genérico permanece igual. Censo concluído após prontidão fica fora dos custos;
retroagir seus valores incluiria trabalho posterior ao evento. Sem censo concluído antes da prontidão,
os custos ficam nulos e a tentativa não é qualificada, mesmo com tempos hello/health no journal bruto.
Qualificação apenas de latência não faz parte deste estudo.

### Artefatos e disposições retidas

O runtime GNU usado para prontidão é R12, versão `0.1.1-bench.10`. R0/R1/R2 são os três artefatos
limpos do runtime; os demais IDs seguem a ordem das novas versões. Todos os builds do launcher
geraram L0. H+Z indica o hub compilado e seu sidecar Zig. Campos de texto vazios em H/Z significam
identidade de seção não coletada, não zero bytes. S é o artefato GNU sem strip, construído à parte.

<details>
<summary>Identidades dos artefatos (CSV)</summary>

```csv
artifact_id,kind,version,file_bytes,text_bytes,file_sha256,text_sha256
R0,runtime,0.1.1,26433712,19822405,7777e6fe212ce80a49bca899543cff4b4f9437e470a13276939169afdab58838,2723a7a7e12151a70d21dddf4bb79a4617d6dc20554502b8e0a5184a6bdeca61
R1,runtime,0.1.1,26433712,19822405,c640a23c6e70a77594d22be72204d680f81e9d5d759239100be3a293a2f70d2e,beb616b9831494f9152417116eaa4306b5d7a4869a411a49649c2a670aeeadb3
R2,runtime,0.1.1,26433712,19822405,8df45395cb6af753ccac9b2679893da070c7d442f54d502eeddf3e8a50a4b71c,94891509d06980b8ef9d23d03f9e250ed520082e103120d6808242afbf8a8043
L0,launcher,0.1.1,2223128,1570246,afd2a4fa9bd6e9305aa05409c4eaa483bbe2d03b5169ce501a17f282bab6f1d7,2b32b9c9405a8f80edae61b875030b3d43464b3538b395543f67e03d364420be
R3,runtime,0.1.1-bench.1,26433776,19822469,3c9d97c4ec2ed7fb8180cdf02247e7f34ac1a2c36877d701bdcd6728d77d6b1e,19c1d158b6fcd0b77c168914ba5e65a2ae6d29d4843d78679e290f9e1b581cd5
R4,runtime,0.1.1-bench.2,26433776,19822469,213f469e7f4fd96d2311e93acde57b206f847af123270709f1b7741fe89a8966,3a64ceee9f2bedeebb73802c6caac1ffcb4e23be67373c14123aa42e99da792b
R5,runtime,0.1.1-bench.3,26433776,19822469,84031a18fc7085991403b3530a64dfed645c02c01c080438213c3b4fd48347d8,9299be76f6778f263408483b897e8aca43cdd9a4192ecbe59e7fc7f160a19b18
R6,runtime,0.1.1-bench.4,26433776,19822469,79c4a51976fcb5b849a76cd02cfe2359178c755d6615b0cca62a76d88ad5d7b1,6d8a71a50c7cdf87ca16fe24b040c2868cb33b71f0caa6ae8cda92b94a4b2ef7
R7,runtime,0.1.1-bench.5,26433776,19822469,6ec6653befa8b86ed82c0128b74181c9cd1578165f659776a567fbe444a4a31d,612530561d854012e9fe1ffa7e962dc6fb1628b19b6f9a0d16955d4215c21c17
R8,runtime,0.1.1-bench.6,26433776,19822469,a7de7be80f0d9e565be3aa580aa2aa30b927da9c830b3d25b273685d67b030ff,5f34df99b04df8334b4e713232075134cde1c35b4b7ceb9c9d17db52de67bea9
R9,runtime,0.1.1-bench.7,26433776,19822469,c01174c0ee87177accf1dae17078246e9be0ceeb0a15be727a94b0f712dc9630,301ce577d91022548e516690a1326d1df9ed5a46bf2359545b22a9377571c555
R10,runtime,0.1.1-bench.8,26433776,19822469,70a9d3c507bac3ded8e979d45fcd173f9a0e533953fccc3a5a767f837979549e,f625d7922986b8ea7f1120202478eb2850c288f40f886d4274efd83656467e47
R11,runtime,0.1.1-bench.9,26433776,19822469,40f8054a56d8eeb03bf74aa0ed7d6749b7c2dce0f1564b1ec6ac02858c780a8c,ac1cecf491d802ba331f2159188f3a35589ecc42607c31236b9782372211cf9d
R12,runtime,0.1.1-bench.10,26433776,19822469,86d79b93e822d09912ae07dcd3785ab4825296aaa0cc56280f065fcaba47eaba,395139e727727e3a51303eb3aac411e24c3baf602e677a2176a12276e2f74d9e
H,compiled-hub,0.1.1,127743968,,1b82f44b99a6dc4c48a692819cfa54aa299dcaab6558f8912701fbcdd38ded1d,
Z,zig-runtime,0.1.1,26182344,,ce2c17835cf6736468aef01d185e74613fec91f43835a267b68a12892fb52bc3,
S,unstripped-gnu-runtime,0.1.1-bench.10,36120128,19820101,24ead16b32f7b246564818aac43473594838093dd9272c670bd8902bb87f3083,e8770368558c0159c7a80945d64283ab99fea66db62004c4aaade7f6165488fd
```

</details>

A atribuição S ficou retida sem qualificação: seu SHA-256 de `.text`
`e8770368558c0159c7a80945d64283ab99fea66db62004c4aaade7f6165488fd` difere do R12,
`395139e727727e3a51303eb3aac411e24c3baf602e677a2176a12276e2f74d9e`.
Nenhuma decomposição por dependência foi aceita para R12 ou Z. Não houve repetição para substituir
esse resultado.

A admissão anterior v1, em `5e267450`, preservou o payload de metadados de 1.691.503 bytes/329 pacotes
e a rejeição pelo limite de texto. Nenhuma amostra de build/inicialização ocorreu; os 26 builds, a
atribuição e as 66 inicializações ficaram não executados naquele lote. V2 tem outro identificador e
retém todas as 92 tentativas de build/inicialização sem repetição, além da atribuição não qualificada.
Nenhuma falha virou aquecimento. Setup funcional e testes de fixtures não são pontuados. Windows/macOS
nativos continuam não executados.

A reserva de três horas usou TERM em 10.755 s, escalada de 30 s e reserva final de 15 s. O gate de
40 GiB verificou alocação entre tentativas, sem quota rígida durante um build. O maior limite de
build registrado foi 2.280.787.968 bytes; o setup usou separadamente 564.727.808 bytes. Todos os comandos
terminaram sem erro ou falha histórica de censo e com escopo vazio: 138 recibos de comandos, 2.470
identidades próprias observadas e zero sobreviventes finais. Selos finais de revisão/entradas/tools/H/Z
continuaram iguais.

<details>
<summary>Todas as tentativas e amostras numéricas brutas (CSV)</summary>

Tempos em milissegundos; bytes e KiB estão nomeados. Linhas `phase=warmup` são retidas, linhas
`valid=false` não têm valores de desempenho aceitos e campos numéricos vazios estão indisponíveis.
`hello_ms` e `ready_ms` do runtime usam a origem de lançamento; `ready_ms` do hub termina no health HTTP.

```csv
attempt,scenario,phase,status,valid,build_elapsed_ms,final_user_cpu_ms,final_system_cpu_ms,max_individual_rss_kib,spawn_ms,hello_ms,ready_ms,peak_sampled_tree_rss_bytes,sampled_user_cpu_ms,sampled_system_cpu_ms,observed_process_count,resource_sample_count,artifact_id,failure_code,disposition
v1-metadata-default,admission,unscored,rejected,false,,,,,,,,,,,,,,TEXT_LINE_LIMIT,zero_build_or_startup_trials
runtime-empty-1,runtime-empty,measured,completed,true,471520,853360.00,38340.00,2133896,,,,4619079680,849510,33340,537,20045,R0,,
runtime-empty-2,runtime-empty,measured,completed,true,473020,854950.00,36470.00,2133488,,,,4626513920,850870,31080,546,20001,R1,,
runtime-empty-3,runtime-empty,measured,completed,true,471980,854690.00,35950.00,2132668,,,,4614483968,850930,30630,558,19963,R2,,
launcher-empty-1,launcher-empty,measured,completed,true,44610,69590.00,5390.00,426524,,,,1315807232,68270,4160,161,1913,L0,,
launcher-empty-2,launcher-empty,measured,completed,true,44350,70170.00,5480.00,426548,,,,1294999552,68900,4120,160,1911,L0,,
launcher-empty-3,launcher-empty,measured,completed,true,44740,70260.00,5210.00,426792,,,,1315934208,69000,3950,161,1920,L0,,
runtime-noop-1,runtime-noop,measured,completed,true,380,220.00,130.00,77512,,,,79372288,210,120,1,16,R2,,
runtime-restamp-1,runtime-restamp,measured,completed,true,234360,230430.00,3900.0,2132840,,,,2254336000,230420,3870,5,10198,R3,,
runtime-noop-2,runtime-noop,measured,completed,true,430,280.00,100.0,77316,,,,79171584,270,100,1,18,R3,,
runtime-restamp-2,runtime-restamp,measured,completed,true,236540,232560.00,3930.00,2131820,,,,2261032960,232540,3880,5,10283,R4,,
runtime-noop-3,runtime-noop,measured,completed,true,410,280.00,100.0,77332,,,,79187968,280,90,1,18,R4,,
runtime-restamp-3,runtime-restamp,measured,completed,true,235870,231780.00,4110.00,2133908,,,,2248216576,231760,4050,5,10324,R5,,
runtime-noop-4,runtime-noop,measured,completed,true,360,210.00,110.00,77360,,,,78954496,210,100,1,15,R5,,
runtime-restamp-4,runtime-restamp,measured,completed,true,233110,228850.00,4250.00,2133592,,,,2255548416,228820,4170,5,10172,R6,,
runtime-noop-5,runtime-noop,measured,completed,true,390,260.00,110.00,77512,,,,79110144,260,110,1,17,R6,,
runtime-restamp-5,runtime-restamp,measured,completed,true,233730,229680.00,4060.00,2132800,,,,2250551296,229660,4020,5,10183,R7,,
runtime-noop-6,runtime-noop,measured,completed,true,400,250.00,110.00,77212,,,,78798848,250,100,1,18,R7,,
runtime-restamp-6,runtime-restamp,measured,completed,true,233990,229780.00,4180.00,2133436,,,,2263916544,229750,4140,5,10178,R8,,
runtime-noop-7,runtime-noop,measured,completed,true,380,230.00,120.00,77464,,,,79323136,230,110,1,17,R8,,
runtime-restamp-7,runtime-restamp,measured,completed,true,233540,229650.00,3900.0,2133600,,,,2250235904,229650,3850,5,10144,R9,,
runtime-noop-8,runtime-noop,measured,completed,true,380,240.00,110.00,77556,,,,79417344,240,100,1,17,R9,,
runtime-restamp-8,runtime-restamp,measured,completed,true,237260,232920.00,4340.00,2133936,,,,2255400960,232920,4300,5,10292,R10,,
runtime-noop-9,runtime-noop,measured,completed,true,390,200.0,150.00,77852,,,,79458304,200,140,1,17,R10,,
runtime-restamp-9,runtime-restamp,measured,completed,true,238750,234640.00,4140.00,2133600,,,,2259374080,234610,4110,5,10343,R11,,
runtime-noop-10,runtime-noop,measured,completed,true,400,210.00,150.00,77180,,,,79032320,210,140,1,18,R11,,
runtime-restamp-10,runtime-restamp,measured,completed,true,234660,230850.00,3830.00,2134132,,,,2264276992,230800,3800,5,10208,R12,,
v2-attribution,attribution,unscored,completed,false,,,,,,,,,,,,,S,TEXT_HASH_MISMATCH,no_accepted_dependency_breakdown
runtime-readiness-warmup-1,runtime-readiness,warmup,success,true,,,,,6.2366009999999505,200.79503499999998,318.54725499999995,70750208,150,90,6,30,R12,,excluded_warmup
runtime-readiness-warmup-2,runtime-readiness,warmup,success,true,,,,,1.1906999999999925,185.158632,314.75105399999995,71258112,150,90,7,31,R12,,excluded_warmup
runtime-readiness-measured-1,runtime-readiness,measured,success,true,,,,,1.1337999999998374,193.77573299999995,327.4780559999999,70168576,170,80,7,32,R12,,accepted
runtime-readiness-measured-2,runtime-readiness,measured,success,true,,,,,1.026700000000119,214.14763700000003,352.48836099999994,70737920,160,100,8,35,R12,,accepted
runtime-readiness-measured-3,runtime-readiness,measured,success,true,,,,,1.0259000000000924,176.49273100000005,308.44715299999984,68075520,150,60,7,30,R12,,accepted
runtime-readiness-measured-4,runtime-readiness,measured,success,true,,,,,1.1632010000002992,196.5708340000001,330.07255699999996,69898240,150,100,7,32,R12,,accepted
runtime-readiness-measured-5,runtime-readiness,measured,success,true,,,,,0.8355999999998858,197.90753399999994,328.36795699999993,71102464,140,100,7,32,R12,,accepted
runtime-readiness-measured-6,runtime-readiness,measured,success,true,,,,,1.1205999999997402,193.6984339999999,324.5070559999999,71266304,160,90,8,32,R12,,accepted
runtime-readiness-measured-7,runtime-readiness,measured,success,true,,,,,1.540599999999813,186.84803199999988,320.8847549999996,71442432,150,80,4,31,R12,,accepted
runtime-readiness-measured-8,runtime-readiness,measured,success,true,,,,,1.0502999999998792,184.89793199999986,315.7131549999999,69210112,160,80,6,31,R12,,accepted
runtime-readiness-measured-9,runtime-readiness,measured,success,true,,,,,1.284099999999853,174.82352999999966,305.87655299999915,70942720,150,70,7,30,R12,,accepted
runtime-readiness-measured-10,runtime-readiness,measured,success,true,,,,,2.488199999999779,198.91473399999995,336.64595800000006,63619072,160,90,7,32,R12,,accepted
runtime-readiness-measured-11,runtime-readiness,measured,success,true,,,,,1.4564999999993233,179.80213099999946,306.63135299999976,69263360,140,70,7,30,R12,,accepted
runtime-readiness-measured-12,runtime-readiness,measured,success,true,,,,,1.1925010000004477,201.9923349999999,327.7353570000005,70496256,170,80,7,32,R12,,accepted
runtime-readiness-measured-13,runtime-readiness,measured,success,true,,,,,13.566102000000683,185.28713200000038,328.6586560000005,70410240,150,70,7,29,R12,,accepted
runtime-readiness-measured-14,runtime-readiness,measured,success,true,,,,,1.0830009999999675,213.28773699999965,345.90736000000015,71081984,170,100,7,34,R12,,accepted
runtime-readiness-measured-15,runtime-readiness,measured,success,true,,,,,1.453799999999319,183.55233099999987,315.6487539999998,68579328,130,110,7,31,R12,,accepted
runtime-readiness-measured-16,runtime-readiness,measured,success,true,,,,,1.2429000000001906,176.73141399999986,317.30101100000047,68849664,100,100,7,31,R12,,accepted
runtime-readiness-measured-17,runtime-readiness,measured,success,true,,,,,1.0574010000000271,193.95833399999992,320.76262099999985,71598080,120,120,7,32,R12,,accepted
runtime-readiness-measured-18,runtime-readiness,measured,success,true,,,,,7.150104999999712,202.9333399999996,333.9677299999994,70479872,170,60,6,32,R12,,accepted
runtime-readiness-measured-19,runtime-readiness,measured,success,true,,,,,1.4121010000008027,185.46872800000074,316.31451800000013,69980160,140,110,7,31,R12,,accepted
runtime-readiness-measured-20,runtime-readiness,measured,success,true,,,,,1.0802010000006703,210.88544600000023,339.8766340000002,67747840,170,70,7,34,R12,,accepted
hub-fresh-readiness-warmup-1,hub-fresh-readiness,warmup,success,true,,,,,,,435.044626,126464000,690,120,2,42,H+Z,,excluded_warmup
hub-fresh-readiness-warmup-2,hub-fresh-readiness,warmup,success,true,,,,,,,421.3866260000002,115372032,660,130,2,41,H+Z,,excluded_warmup
hub-fresh-readiness-measured-1,hub-fresh-readiness,measured,success,true,,,,,,,446.75072699999987,120004608,650,180,2,44,H+Z,,accepted
hub-fresh-readiness-measured-2,hub-fresh-readiness,measured,success,true,,,,,,,413.75042600000006,109154304,590,160,2,39,H+Z,,accepted
hub-fresh-readiness-measured-3,hub-fresh-readiness,measured,success,true,,,,,,,399.51852400000007,114720768,650,120,2,39,H+Z,,accepted
hub-fresh-readiness-measured-4,hub-fresh-readiness,measured,success,true,,,,,,,430.3694220000002,119001088,650,150,2,42,H+Z,,accepted
hub-fresh-readiness-measured-5,hub-fresh-readiness,measured,success,true,,,,,,,425.92542199999934,121442304,670,150,2,41,H+Z,,accepted
hub-fresh-readiness-measured-6,hub-fresh-readiness,measured,success,true,,,,,,,380.52631999999994,112607232,600,160,2,36,H+Z,,accepted
hub-fresh-readiness-measured-7,hub-fresh-readiness,measured,success,true,,,,,,,360.7423180000005,119189504,600,150,2,36,H+Z,,accepted
hub-fresh-readiness-measured-8,hub-fresh-readiness,measured,success,true,,,,,,,430.78462300000047,117604352,600,190,2,42,H+Z,,accepted
hub-fresh-readiness-measured-9,hub-fresh-readiness,measured,success,true,,,,,,,414.63482100000056,123932672,630,170,2,41,H+Z,,accepted
hub-fresh-readiness-measured-10,hub-fresh-readiness,measured,success,true,,,,,,,408.3656209999999,121106432,640,130,2,40,H+Z,,accepted
hub-fresh-readiness-measured-11,hub-fresh-readiness,measured,success,true,,,,,,,369.334519,111173632,600,130,2,36,H+Z,,accepted
hub-fresh-readiness-measured-12,hub-fresh-readiness,measured,success,true,,,,,,,420.8633209999989,121188352,670,150,2,41,H+Z,,accepted
hub-fresh-readiness-measured-13,hub-fresh-readiness,measured,success,true,,,,,,,404.7155210000001,116912128,610,150,2,40,H+Z,,accepted
hub-fresh-readiness-measured-14,hub-fresh-readiness,measured,success,true,,,,,,,406.7143209999995,124825600,680,130,2,40,H+Z,,accepted
hub-fresh-readiness-measured-15,hub-fresh-readiness,measured,success,true,,,,,,,422.18132199999854,117268480,690,100,2,42,H+Z,,accepted
hub-fresh-readiness-measured-16,hub-fresh-readiness,measured,success,true,,,,,,,417.7075190000014,117174272,630,170,2,41,H+Z,,accepted
hub-fresh-readiness-measured-17,hub-fresh-readiness,measured,success,true,,,,,,,437.6990189999997,113909760,570,220,2,43,H+Z,,accepted
hub-fresh-readiness-measured-18,hub-fresh-readiness,measured,success,true,,,,,,,439.97991999999977,109154304,660,160,2,43,H+Z,,accepted
hub-fresh-readiness-measured-19,hub-fresh-readiness,measured,success,true,,,,,,,433.507520000001,116256768,660,130,2,40,H+Z,,accepted
hub-fresh-readiness-measured-20,hub-fresh-readiness,measured,success,true,,,,,,,423.4568199999994,107888640,620,170,1,41,H+Z,,accepted
hub-migrated-readiness-warmup-1,hub-migrated-readiness,warmup,success,true,,,,,,,426.2574390000001,117972992,620,170,2,41,H+Z,,excluded_warmup
hub-migrated-readiness-warmup-2,hub-migrated-readiness,warmup,success,true,,,,,,,304.897156,108498944,520,90,2,30,H+Z,,excluded_warmup
hub-migrated-readiness-measured-1,hub-migrated-readiness,measured,success,true,,,,,,,358.86004800000023,119259136,530,170,2,35,H+Z,,accepted
hub-migrated-readiness-measured-2,hub-migrated-readiness,measured,success,true,,,,,,,357.6220489999996,116494336,540,120,2,35,H+Z,,accepted
hub-migrated-readiness-measured-3,hub-migrated-readiness,measured,success,true,,,,,,,319.77615400000013,116420608,540,110,2,32,H+Z,,accepted
hub-migrated-readiness-measured-4,hub-migrated-readiness,measured,success,true,,,,,,,348.2525780000001,107347968,530,120,2,34,H+Z,,accepted
hub-migrated-readiness-measured-5,hub-migrated-readiness,measured,success,true,,,,,,,358.03189199999997,109060096,520,130,2,35,H+Z,,accepted
hub-migrated-readiness-measured-6,hub-migrated-readiness,measured,success,true,,,,,,,353.610592,115113984,540,150,2,34,H+Z,,accepted
hub-migrated-readiness-measured-7,hub-migrated-readiness,measured,success,true,,,,,,,324.50789299999997,105222144,510,120,1,31,H+Z,,accepted
hub-migrated-readiness-measured-8,hub-migrated-readiness,measured,success,true,,,,,,,347.38549200000034,121212928,560,120,2,34,H+Z,,accepted
hub-migrated-readiness-measured-9,hub-migrated-readiness,measured,success,true,,,,,,,347.14569200000005,112766976,540,130,2,34,H+Z,,accepted
hub-migrated-readiness-measured-10,hub-migrated-readiness,measured,success,true,,,,,,,352.5651909999997,116948992,570,130,2,35,H+Z,,accepted
hub-migrated-readiness-measured-11,hub-migrated-readiness,measured,success,true,,,,,,,330.24599300000045,107978752,550,130,1,32,H+Z,,accepted
hub-migrated-readiness-measured-12,hub-migrated-readiness,measured,success,true,,,,,,,343.52159199999915,117764096,490,190,2,34,H+Z,,accepted
hub-migrated-readiness-measured-13,hub-migrated-readiness,measured,success,true,,,,,,,329.71019200000046,109215744,500,170,1,32,H+Z,,accepted
hub-migrated-readiness-measured-14,hub-migrated-readiness,measured,success,true,,,,,,,286.3768940000009,109752320,440,170,2,28,H+Z,,accepted
hub-migrated-readiness-measured-15,hub-migrated-readiness,measured,success,true,,,,,,,341.63469199999963,114315264,480,160,2,34,H+Z,,accepted
hub-migrated-readiness-measured-16,hub-migrated-readiness,measured,success,true,,,,,,,365.15099100000043,119648256,590,120,2,36,H+Z,,accepted
hub-migrated-readiness-measured-17,hub-migrated-readiness,measured,success,true,,,,,,,350.3084920000001,115691520,560,100,2,34,H+Z,,accepted
hub-migrated-readiness-measured-18,hub-migrated-readiness,measured,success,true,,,,,,,350.09461199999896,113946624,540,140,2,34,H+Z,,accepted
hub-migrated-readiness-measured-19,hub-migrated-readiness,measured,success,true,,,,,,,356.09021199999916,115187712,560,120,2,35,H+Z,,accepted
hub-migrated-readiness-measured-20,hub-migrated-readiness,measured,success,true,,,,,,,353.25731199999973,111321088,470,170,2,35,H+Z,,accepted
```

</details>
