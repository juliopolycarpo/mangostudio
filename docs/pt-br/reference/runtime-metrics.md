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

Os lotes executáveis recusam seletores de ambiente Cargo de build/cache/perfil, seletores de
linker/rustflags por target e substituições diretas de compilador/saída/incremental.
`RUSTC_BOOTSTRAP` e `RUSTC_STAGE` não podem estar definidos. Valores vazios também são recusados, pois
scripts de build usam a presença dessas variáveis para escolher testes de features. O selo inclui os
dois nomes de configuração Cargo em cada diretório ancestral e no Cargo home, inclusive arquivos
ausentes ou ignorados pela precedência. `config` sem extensão precede `config.toml`. Configurações
externas ativas só podem conter ajustes de registro/rede/credenciais; includes e substituições de
compilador/perfil/saída são recusados. Os recibos guardam caminhos e hashes, não os valores. Essas
regras valem para novos lotes; estudos preservados mantêm suas fontes e regras de admissão originais.

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

Erros de recursos, ausência de observações terminais ou identidades restantes deixam a limpeza sem
confirmação e preservam o diretório privado, mesmo quando o escopo nativo separado está vazio. Sem
observações anteriores à prontidão, a amostra continua sendo uma falha de custo; evidência terminal
vazia e bem-sucedida ainda permite a limpeza normal.

O driver trata SIGINT/SIGTERM cancelando o comando supervisionado ativo, encerrando sua árvore
verificada, registrando a tentativa interrompida e parando o lote. Timeouts externos com SIGKILL
exigem um supervisor externo: o processo morto não consegue executar sua própria limpeza.
Cancelamento e prazo simultâneos compartilham a operação de limpeza iniciada; o relato terminal
aguarda seu término e preserva as duas causas de parada.

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

| Carga                   |   n |   Mín s | Mediana s |   p95 s |   Máx s | Amplitude s | CPU final mediana usuário/sistema s | RSS amostrado mediano da árvore MiB |
| ----------------------- | --: | ------: | --------: | ------: | ------: | ----------: | ----------------------------------: | ----------------------------------: |
| Runtime, target vazio   |   3 | 471.520 |   471.980 |       — | 473.020 |       1.500 |                    854.690 / 36.470 |                            4405.098 |
| Launcher, target vazio  |   3 |  44.350 |    44.610 |       — |  44.740 |       0.390 |                      70.170 / 5.390 |                            1254.852 |
| Runtime, sem alterações |  10 |   0.360 |     0.390 |   0.430 |   0.430 |       0.070 |                       0.235 / 0.110 |                              75.512 |
| Runtime, nova versão    |  10 | 233.110 |   234.510 | 238.750 | 238.750 |       5.640 |                     230.640 / 4.085 |                            2150.988 |

Após a atribuição não pontuada, hello/health do runtime, health do hub com banco novo e health com
banco migrado executaram dois aquecimentos retidos e vinte tentativas medidas cada. As 66 passaram;
os seis aquecimentos ficam fora dos resumos e permanecem abaixo. Hello negociado do runtime teve
mín/mediana/p95/máx/amplitude de 174,824 / 193,737 / 213,288 / 214,148 / 39,324 ms (n=20).

| Prontidão útil                   |   n |  Mín ms | Mediana ms |  p95 ms |  Máx ms | Amplitude ms | CPU amostrada mediana usuário/sistema ms | RSS amostrado mediano da árvore MiB |
| -------------------------------- | --: | ------: | ---------: | ------: | ------: | -----------: | ---------------------------------------: | ----------------------------------: |
| Runtime GNU hello + health       |  20 | 305.877 |    325.993 | 345.907 | 352.488 |       46.612 |                                 150 / 85 |                              67.033 |
| Hub + runtime Zig, banco novo    |  20 | 360.742 |    419.285 | 439.980 | 446.751 |       86.008 |                                635 / 150 |                             111.791 |
| Hub + runtime Zig, banco migrado |  20 | 286.377 |    349.174 | 358.860 | 365.151 |       78.774 |                                540 / 130 |                             109.400 |

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

## Grupo com símbolos compatíveis, 2026-10-23

Um grupo GNU separado e **não pontuado** completa a atribuição atual por dependência. Usa a revisão
`805d2b536e5d5ad7e959bb0c1b5d3a6290878005`, selo
`6a36c1e4ddf08df28ea196c8655d11607eda77660f2f736b67349dbb9c9ecdcd`, versão `0.1.1`, features padrão,
oito jobs e target `x86_64-unknown-linux-gnu`. Rust/Cargo 1.99.0 (b940084d7 / 5f94df478), LLVM 23.1.1
e Bun 1.4.3 permanecem iguais. Os dois pacotes foram construídos uma vez cada em target Cargo ext4
privado e novo, runtime antes do launcher, com caches de registro/toolchain retidos e Cargo offline.
O perfil release do workspace mantém opt-level 3 / fat LTO / uma unidade de codegen / unwind;
apenas stripping foi desativado para reter símbolos. V3L usa esse perfil de auditoria do workspace;
os valores não qualificam instalações arbitrárias do launcher com perfil cargo install.

O cargo-bloat 0.12.1 fixado tem SHA-256
`28c5f0f8070dc6fe3023066a56f1dcf35e80347fcdeebfe3532e9a732dbb0954`.
Seu caminho GNU injeta `CARGO_PROFILE_RELEASE_STRIP=false`; o debug forçado se aplica apenas a MSVC.
O ambiente filho selado deixou `RUSTFLAGS` e `CARGO_ENCODED_RUSTFLAGS` ausentes. As invocações verbose
dos binários registraram exatamente estes valores de `-C`:

| Binário  | Valores de codegen                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| Runtime  | `opt-level=3`, `lto=fat`, `codegen-units=1`, `metadata=e2d8f00e67dcf235`, `extra-filename=-1752e5e7b56dac33` |
| Launcher | `opt-level=3`, `lto=fat`, `codegen-units=1`, `metadata=2346ad337e441315`, `extra-filename=-0ba43966a803d021` |

Nenhuma invocação acrescentou `link-dead-code`, `debuginfo`, `strip` ou `panic=abort`; perfil/target
retêm unwind e o padrão sem strip. As seções de debug retidas aparecem abaixo, sem inferir sua
ausência pelas flags do compilador. Essas flags e hashes definem o grupo; três campos de perfil
iguais não estabelecem equivalência com outro artefato.

V3R e V3L são novas cópias com strip após link dos próprios builds preservados com símbolos.
GNU strip 2.46, SHA-256 `4d2ca6ba80677c3b2975e328306a779cd7bd6590a87948b5ebea9c1b41a049c8`,
aplicou `--strip-all` em cada cópia. Cargo define `strip=true` como `strip="symbols"`, e GNU
`--strip-all` remove símbolos. Isso reproduz a política de stripping sem afirmar identidade binária
com um arquivo anterior linkado pelo Cargo. Veja a [documentação de perfis Cargo](https://doc.rust-lang.org/cargo/reference/profiles.html#strip)
e o [manual GNU strip](https://sourceware.org/binutils/docs/binutils/strip.html).

Os dois pares têm bytes e SHA-256 de `.text` exatamente iguais antes/depois, originais/cópias com
símbolos inalterados, seções estáticas de símbolos/debug removidas e tamanhos/endereços preservados
de `.text`, `.rodata`, `.eh_frame` e `.gcc_except_table`. `--version` do runtime devolveu `0.1.1` com
home isolado. O launcher nunca foi executado; sua versão veio dos metadados Cargo selados. Os arquivos
com strip têm **26.430.696 bytes** (V3R) e **2.223.120 bytes** (V3L). A atribuição é aceita apenas para
essas cópias novas. A atribuição antiga a R12/Z continua rejeitada; todas as medições v2, aquecimentos,
admissão falha e resultado de símbolos não qualificado acima permanecem iguais.

### Atribuição atual e cobertura

`--crates --split-std -n 0` reteve todas as 130 linhas do runtime e 38 do launcher, sem filtro ou
limite de primeiras linhas. Crates nomeados, símbolos desconhecidos e resíduo somam exatamente `.text`:

| Artefato | Linhas de crates | Bytes de texto | Bytes de crates nomeados | Bytes de símbolos desconhecidos | Texto residual em bytes |
| -------- | ---------------: | -------------: | -----------------------: | ------------------------------: | ----------------------: |
| V3R      |              130 |       19820037 |                 18737863 |                          912729 |                  169445 |
| V3L      |               38 |        1570246 |                  1482460 |                           71253 |                   16533 |

A atribuição por crate sob fat LTO continua heurística, incluindo código compartilhado/inlined.
`[Unknown]` contém símbolos que a ferramenta não atribuiu; `[Residual]` é `.text` fora da soma de
símbolos, incluindo bytes não atribuídos ou preenchimento. O resíduo fica separado, sem ser dado a uma
dependência. As linhas incluem a aplicação e crates separados da biblioteca padrão. Pacotes sem
símbolos atribuídos não aparecem; a ausência não prova contribuição zero. A atribuição vale para
`.text`, não para o arquivo inteiro ou memória em execução. Todas as linhas de crates e os tamanhos
completos das seções ELF estão abaixo. `NOBITS` indica tamanho em memória, não bytes no arquivo.
Campo vazio de seção stripped significa que a seção foi removida.

<details>
<summary>Identidades dos novos artefatos compatíveis (CSV)</summary>

```csv
artifact_id,package,version,file_bytes,text_bytes,file_sha256,text_sha256
V3R-symbols,mangostudio-runtime,0.1.1,36120064,19820037,ccb8f44ef8d3e78b1f6bb84bef1a6f9e6bad9211ecfd2c34efcc8eb4279fc915,a936d68748eacfcfe86889279ef4c30d4835d371fee273d30715f5a1ebb10ed3
V3R,mangostudio-runtime,0.1.1,26430696,19820037,7a8e792aec2f42144b0b3fd487fac0bbd44ff917acb44df511d413f732bf870e,a936d68748eacfcfe86889279ef4c30d4835d371fee273d30715f5a1ebb10ed3
V3L-symbols,mangostudio,0.1.1,6575560,1570246,7d83415f7c9129257407bc7778ce98f4a723fb380b9fb0c1d6cce3ee3bb03d94,4f7feed6909387a51e2a8ce0eb57e3c5f034563273b87f5153564dc5ba1a9e2d
V3L,mangostudio,0.1.1,2223120,1570246,8906b428ac27b17b5568915596839c2b6512f01fb5836636859bba70892e358b,4f7feed6909387a51e2a8ce0eb57e3c5f034563273b87f5153564dc5ba1a9e2d
```

</details>

<details>
<summary>Tamanhos completos das seções (CSV)</summary>

Leituras independentes dos dois arquivos ELF com símbolos retornaram tamanhos iguais para
`.debug_loclists` (1.117.567 bytes), `.debug_rnglists` (52.758), `.debug_macro` (38.458) e
`.debug_line_str` (7.661). As três primeiras seções têm hashes SHA-256 diferentes entre V3R e V3L;
`.debug_line_str` tem o mesmo hash. Estes são tamanhos observados das seções e não implicam
binários iguais.

```csv
artifact_id,section,elf_type,symbol_bytes,stripped_bytes,symbol_address,stripped_address
V3R,.interp,PROGBITS,28,28,736,736
V3R,.note.ABI-tag,NOTE,32,32,764,764
V3R,.note.gnu.build-id,NOTE,36,36,796,796
V3R,.dynsym,DYNSYM,5568,5568,832,832
V3R,.gnu.version,VERSYM,464,464,6400,6400
V3R,.gnu.version_r,VERNEED,528,528,6864,6864
V3R,.gnu.hash,GNU_HASH,28,28,7392,7392
V3R,.dynstr,STRTAB,3006,3006,7420,7420
V3R,.rela.dyn,RELA,632712,632712,10432,10432
V3R,.rela.plt,RELA,1680,1680,643144,643144
V3R,.gcc_except_table,PROGBITS,1037452,1037452,644824,644824
V3R,.rodata,PROGBITS,2777792,2777792,1683456,1683456
V3R,.eh_frame_hdr,PROGBITS,181292,181292,4461248,4461248
V3R,.eh_frame,PROGBITS,1498328,1498328,4642544,4642544
V3R,.text,PROGBITS,19820037,19820037,6145024,6145024
V3R,.init,PROGBITS,27,27,25965064,25965064
V3R,.fini,PROGBITS,13,13,25965092,25965092
V3R,.plt,PROGBITS,1136,1136,25965120,25965120
V3R,.tdata,PROGBITS,249,249,25970352,25970352
V3R,.tbss,NOBITS,168,168,25970608,25970608
V3R,.fini_array,FINI_ARRAY,8,8,25970608,25970608
V3R,.init_array,INIT_ARRAY,16,16,25970616,25970616
V3R,.data.rel.ro,PROGBITS,454400,454400,25970656,25970656
V3R,.dynamic,DYNAMIC,464,464,26425056,26425056
V3R,.got,PROGBITS,2464,2464,26425520,26425520
V3R,.got.plt,PROGBITS,584,584,26427984,26427984
V3R,.relro_padding,NOBITS,2920,2920,26428568,26428568
V3R,.tm_clone_table,PROGBITS,0,0,26432664,26432664
V3R,.data,PROGBITS,7704,7704,26432672,26432672
V3R,.bss,NOBITS,536,536,26440384,26440384
V3R,.comment,PROGBITS,177,177,0,0
V3R,.debug_abbrev,PROGBITS,15239,,0,
V3R,.debug_info,PROGBITS,1042037,,0,
V3R,.debug_aranges,PROGBITS,14656,,0,
V3R,.debug_ranges,PROGBITS,283024,,0,
V3R,.debug_str,PROGBITS,1444143,,0,
V3R,.debug_line,PROGBITS,510268,,0,
V3R,.debug_loclists,PROGBITS,1117567,,0,
V3R,.debug_rnglists,PROGBITS,52758,,0,
V3R,.debug_macro,PROGBITS,38458,,0,
V3R,.debug_line_str,PROGBITS,7661,,0,
V3R,.symtab,SYMTAB,868848,,0,
V3R,.shstrtab,STRTAB,478,318,0,0
V3R,.strtab,STRTAB,4293767,,0,
V3L,.interp,PROGBITS,28,28,736,736
V3L,.note.ABI-tag,NOTE,32,32,764,764
V3L,.note.gnu.build-id,NOTE,36,36,796,796
V3L,.dynsym,DYNSYM,3096,3096,832,832
V3L,.gnu.version,VERSYM,258,258,3928,3928
V3L,.gnu.version_r,VERNEED,336,336,4188,4188
V3L,.gnu.hash,GNU_HASH,28,28,4528,4528
V3L,.dynstr,STRTAB,1689,1689,4556,4556
V3L,.rela.dyn,RELA,60240,60240,6248,6248
V3L,.rela.plt,RELA,96,96,66488,66488
V3L,.gcc_except_table,PROGBITS,37248,37248,66584,66584
V3L,.rodata,PROGBITS,357029,357029,106496,106496
V3L,.eh_frame_hdr,PROGBITS,17876,17876,463528,463528
V3L,.eh_frame,PROGBITS,119836,119836,481408,481408
V3L,.text,PROGBITS,1570246,1570246,605376,605376
V3L,.init,PROGBITS,27,27,2175624,2175624
V3L,.fini,PROGBITS,13,13,2175652,2175652
V3L,.plt,PROGBITS,80,80,2175680,2175680
V3L,.tdata,PROGBITS,49,49,2179856,2179856
V3L,.tbss,NOBITS,72,72,2179912,2179912
V3L,.fini_array,FINI_ARRAY,8,8,2179912,2179912
V3L,.init_array,INIT_ARRAY,16,16,2179920,2179920
V3L,.data.rel.ro,PROGBITS,43872,43872,2179936,2179936
V3L,.dynamic,DYNAMIC,448,448,2223808,2223808
V3L,.got,PROGBITS,1696,1696,2224256,2224256
V3L,.got.plt,PROGBITS,56,56,2225952,2225952
V3L,.relro_padding,NOBITS,2216,2216,2226008,2226008
V3L,.tm_clone_table,PROGBITS,0,0,2230104,2230104
V3L,.data,PROGBITS,2696,2696,2230104,2230104
V3L,.bss,NOBITS,280,280,2232800,2232800
V3L,.comment,PROGBITS,177,177,0,0
V3L,.debug_abbrev,PROGBITS,11257,,0,
V3L,.debug_info,PROGBITS,872900,,0,
V3L,.debug_aranges,PROGBITS,10848,,0,
V3L,.debug_ranges,PROGBITS,213120,,0,
V3L,.debug_str,PROGBITS,1255976,,0,
V3L,.debug_line,PROGBITS,424444,,0,
V3L,.debug_loclists,PROGBITS,1117567,,0,
V3L,.debug_rnglists,PROGBITS,52758,,0,
V3L,.debug_macro,PROGBITS,38458,,0,
V3L,.debug_line_str,PROGBITS,7661,,0,
V3L,.symtab,SYMTAB,76128,,0,
V3L,.shstrtab,STRTAB,478,318,0,0
V3L,.strtab,STRTAB,270389,,0,
```

</details>

<details>
<summary>Todas as linhas de crates e resíduos (CSV)</summary>

```csv
artifact_id,crate,text_bytes
V3R,mangostudio_runtime,3171895
V3R,jsonschema,2640131
V3R,core,2055993
V3R,tokio,1467702
V3R,serde_core,923855
V3R,[Unknown],912729
V3R,rmcp,812748
V3R,mango_external_agents,770040
V3R,mango_protocol,719961
V3R,serde_json,677577
V3R,mango_agent_codex,662288
V3R,mango_agent_acp,539017
V3R,rustls,389951
V3R,ring,283533
V3R,regex_automata,282110
V3R,alloc,245193
V3R,mango_agent_claude,243968
V3R,std,229725
V3R,regex_syntax,180723
V3R,fancy_regex,165461
V3R,referencing,158515
V3R,agent_client_protocol_schema,143232
V3R,aho_corasick,138887
V3R,reqwest,131153
V3R,rquickjs_sys,101939
V3R,serde_with,101496
V3R,serde,95891
V3R,hyper_util,81731
V3R,tungstenite,70362
V3R,http,67143
V3R,webpki,63975
V3R,icu_collator,60777
V3R,futures_util,58873
V3R,hyper,58114
V3R,url,51096
V3R,num_bigint,48725
V3R,indexmap,47557
V3R,hashbrown,42824
V3R,toml,40107
V3R,toml_parser,35367
V3R,gimli,35344
V3R,tokio_util,33732
V3R,data_encoding,27882
V3R,tokio_tungstenite,25092
V3R,darling_core,24026
V3R,idna,23736
V3R,cc,23086
V3R,fluent_uri,22473
V3R,cap_primitives,22360
V3R,rustc_demangle,21251
V3R,jsonschema_regex,20832
V3R,memchr,19808
V3R,proc_macro2,16674
V3R,icu_normalizer,16474
V3R,mangostudio_runtime_contract,16392
V3R,tokio_rustls,16188
V3R,heck,15540
V3R,hyper_rustls,13708
V3R,rustls_pki_types,12187
V3R,jsonschema_value,12056
V3R,addr2line,11631
V3R,smallvec,11416
V3R,sha2,11316
V3R,tracing,10417
V3R,miniz_oxide,9875
V3R,base64,9437
V3R,http_body_util,8538
V3R,rustls_native_certs,8486
V3R,regex,8465
V3R,fraction,8430
V3R,icu_locale_core,7451
V3R,bytes,7215
V3R,rquickjs_core,6860
V3R,parking_lot,6592
V3R,autocfg,6462
V3R,httparse,6381
V3R,icu_locale_fallback,6349
V3R,rustls_platform_verifier,6163
V3R,toml_datetime,5941
V3R,globset,5917
V3R,compiler_builtins,5642
V3R,tower,5599
V3R,getrandom,5566
V3R,ahash,5427
V3R,sha1,5376
V3R,ipnet,5169
V3R,chrono,4539
V3R,icu_provider,4478
V3R,sse_stream,4364
V3R,email_address,4050
V3R,syn,3851
V3R,rustix,3587
V3R,num_rational,3549
V3R,semver,3018
V3R,find_msvc_tools,2827
V3R,futures_channel,2458
V3R,zmij,2396
V3R,rand,1909
V3R,parking_lot_core,1864
V3R,std_detect,1727
V3R,uuid,1493
V3R,zerotrie,1336
V3R,icu_collections,1326
V3R,uuid_simd,1207
V3R,chacha20,1117
V3R,signal_hook_registry,1109
V3R,foldhash,1105
V3R,version_check,1028
V3R,tower_http,1015
V3R,digest,1014
V3R,shlex,874
V3R,itoa,846
V3R,percent_encoding,832
V3R,bit_set,683
V3R,bytecount,645
V3R,convert_case,523
V3R,futures_task,362
V3R,mio,353
V3R,__rustc,341
V3R,want,338
V3R,zerovec,297
V3R,utf8_iter,296
V3R,panic_abort,219
V3R,openssl_probe,87
V3R,strsim,49
V3R,untrusted,44
V3R,unicode_segmentation,36
V3R,nix,26
V3R,http_body,26
V3R,panic_unwind,22
V3R,[Residual],169445
V3L,rustls,379896
V3L,ring,283487
V3L,core,191650
V3L,ureq,135177
V3L,std,116872
V3L,[Unknown],71253
V3L,tar,50247
V3L,webpki,44343
V3L,mangostudio,42132
V3L,gimli,37393
V3L,alloc,34748
V3L,http,29374
V3L,miniz_oxide,22281
V3L,ureq_proto,20738
V3L,rustc_demangle,20659
V3L,addr2line,12836
V3L,sha2,11316
V3L,flate2,8822
V3L,rustls_pki_types,6542
V3L,cc,6078
V3L,bytes,5427
V3L,crc32fast,4717
V3L,httparse,3489
V3L,find_msvc_tools,3096
V3L,hashbrown,2269
V3L,base64,1844
V3L,std_detect,1727
V3L,filetime,969
V3L,simd_adler32,856
V3L,memchr,840
V3L,rustix,708
V3L,getrandom,682
V3L,shlex,548
V3L,__rustc,329
V3L,panic_abort,219
V3L,compiler_builtins,83
V3L,untrusted,44
V3L,panic_unwind,22
V3L,[Residual],16533
```

</details>

### Reprodução e limites

A revisão, ferramentas, perfil e features padrão acima são obrigatórios. Use saída/target novos,
limpe overrides de compilador/perfil não relacionados e confira todas as linhas. Os comandos mostram
o mesmo fluxo build/cópia/strip/seções. O grupo supervisionado executado também exigiu selos de
revisão/tools/evidência antiga iguais, contagens exatas de arquivo/texto do bloat, crates únicos e não
vazios, alocação limitada e escopos finais vazios.

```bash
# From the recorded source, with cargo-bloat 0.12.1 and GNU binutils 2.46.
mkdir -p target
cohort_target=$(mktemp -d "$PWD/target/attribution-v3.XXXXXX")
cohort_out=$(mktemp -d)
cat > "$cohort_out/profile.toml" <<'PROFILE'
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
strip = "none"
panic = "unwind"
PROFILE
for cohort_package in mangostudio-runtime mangostudio; do
  env -i HOME="$HOME" USERPROFILE="$HOME" PATH="$PATH" \
    CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
    CARGO_INCREMENTAL=0 CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=8 \
    MANGOSTUDIO_RELEASE_VERSION=0.1.1 CARGO_PROFILE_RELEASE_STRIP=none \
    cargo bloat --config "$cohort_out/profile.toml" --release --locked -j 8 \
      --target x86_64-unknown-linux-gnu --target-dir "$cohort_target" \
      -p "$cohort_package" --bin "$cohort_package" --crates --split-std -n 0 \
      --message-format json -v > "$cohort_out/$cohort_package.bloat.json"
  cp "$cohort_target/x86_64-unknown-linux-gnu/release/$cohort_package" \
    "$cohort_out/$cohort_package.symbols"
  cp "$cohort_out/$cohort_package.symbols" "$cohort_out/$cohort_package.stripped"
  strip --strip-all -- "$cohort_out/$cohort_package.stripped"
  for cohort_kind in symbols stripped; do
    size -A -d "$cohort_out/$cohort_package.$cohort_kind"
    readelf -h -S -W "$cohort_out/$cohort_package.$cohort_kind"
    objcopy --dump-section ".text=$cohort_out/$cohort_package.$cohort_kind.text" \
      "$cohort_out/$cohort_package.$cohort_kind" "$cohort_out/inspection-copy"
  done
  cmp "$cohort_out/$cohort_package.symbols.text" "$cohort_out/$cohort_package.stripped.text"
  sha256sum "$cohort_out/$cohort_package."{symbols,stripped}{,.text}
done
```

Os dois casos qualificaram sem repetição. Os 17 comandos supervisionados saíram com sucesso, sem
falha histórica de censo e com escopo vazio; 231 identidades próprias foram observadas e zero ficaram.
A última verificação de alocação registrou 1.165.455.360 bytes para o target Cargo privado e
121.614.336 bytes para artefatos/recibos (1.287.069.696 combinados). A reserva foi de 30 minutos com gate de 8 GiB entre etapas, sem quota
rígida durante o build. Nenhum arquivo de fonte/dependência/feature/perfil mudou. Atribuição nativa de
Windows/macOS continua não executada. Este grupo entrega tamanhos e uma linha de base com símbolos
compatíveis; durações de comandos não são pontuadas nem acrescentam tempos de build/inicialização,
otimização ou economia.
