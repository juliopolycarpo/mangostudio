# Gerenciador de ambiente

O MangoStudio consegue dizer a quem não é especialista o que falta na máquina, instalar ou
atualizar com um clique no Linux, macOS e Windows, e garantir que o toolchain escolhido é o que
todo processo iniciado realmente usa: a ferramenta de shell, o terminal, as CLIs de agentes e os
próprios instaladores. A superfície fica em **Ambientes** e descreve a máquina que o parâmetro
`environmentId` nomeia; a própria máquina do hub é `local`.

## Onde cada coisa roda

| Responsabilidade                                                      | Dono                     |
| --------------------------------------------------------------------- | ------------------------ |
| Detectar toolchains, gerenciadores de versão e CLIs de agentes        | Runtime (`apps/runtime`) |
| Montar o ambiente com que um processo inicia (`spawn-env.ts`)         | Runtime (`apps/runtime`) |
| Guardar e validar a seleção de toolchain por ambiente                 | Hub (`apps/api`)         |
| Receitas, guardas, auditoria, findings de pré-requisito e o checklist | Hub (`apps/api`)         |
| Renderizar cards, o seletor e o checklist                             | Frontend                 |

## Checklist de configuração

Ambientes → Visão geral abre com uma seção **Configuração** para quem não sabe o que é um
gerenciador de versão. Cada linha é um finding com o remédio que o resolve:

- Git instalado (no Windows, `git.install.windows` roda `winget install --id Git.Git`);
- um Node LTS que não está abaixo do mínimo do MangoStudio nem fora da janela de suporte;
- Bun, marcado como opcional;
- pelo menos uma CLI de agente instalada **e autenticada**;
- o hub rodando como serviço do usuário, só no ambiente Local.

Nada aqui adiciona endpoint. A seção lê as mesmas queries que as abas Toolchains, Agentes e
Esta máquina já possuem, então o checklist não consegue discordar do `mangostudio doctor`.

## Seleção de toolchain

Todo ambiente carrega uma seleção, `{ node: 'auto' | <caminho>, bun: 'auto' | <caminho> }`,
guardada em `environment_toolchains` com chave `(userId, environmentId)`. O ambiente Local é
virtual, então `local` é uma chave sentinela aqui exatamente como é para execuções de instalação,
e não há chave estrangeira para `environments`. Apagar um ambiente remove a linha na mesma
transação.

- `PUT /api/environments/:id/toolchain` grava um ou ambos os campos. Um caminho só é aceito quando
  a sondagem do próprio ambiente reportou uma instalação exatamente nele; qualquer outro valor é
  um 422 que nomeia os valores esperados e o recebido. Um ambiente que não pode ser sondado
  responde 503.
- Todo ambiente listado inclui seu `toolchain`; ausente vale `auto` para ambos.
- A aba Toolchains oferece **Usar esta versão** em cada instalação de Node e Bun e **Voltar ao
  automático** quando uma está fixada; a linha efetiva diz com o que os processos rodam.

O hub resolve a seleção e a envia em todo método de spawn — `shell.run`, `install.run`,
`terminal.open` e `external-agent.open`. O `spawn-env.ts` do runtime monta o ambiente base uma
vez por spawn: no máximo um diretório por runtime vai para o início do `PATH`, mais `NVM_DIR`,
`FNM_DIR` ou `BUN_INSTALL` quando o diretório veio daquele gerenciador e a variável ainda não
estava definida. Cada consumidor aplica sua própria política de segredos por cima.

`auto` significa "o que um login shell veria", calculado sem executar nenhum profile: o alias
`default` do nvm (incluindo cadeias `lts/*` e os aliases por listagem `node`, `stable` e um major
solto), depois o alias `default` do fnm, depois os diretórios conhecidos que o scanner já usa. No
Windows isso inclui `%ProgramFiles%\nodejs`, porque o MSI do Node edita o `PATH` da máquina e um
runtime que já está rodando nunca vê essa edição. A seleção é omitida para um runtime cujo
manifesto não anuncia `features.toolchain`; esse par mantém seu próprio `PATH` como antes.

## O que o scanner sabe

Cada instalação carrega um `pathSource`: `nvm`, `fnm` e `volta` vêm da classificação de
gerenciador de versão (a raiz padrão do fnm no Windows, `%APPDATA%\fnm`, e a do macOS são
reconhecidas sem `FNM_DIR`); `bun` é o instalador do próprio Bun; `winget` não é visível pelo
caminho, porque o MSI do winget e o do nodejs.org caem ambos em `Program Files\nodejs`, então
uma sondagem no Windows pergunta `winget list --id OpenJS.NodeJS.LTS --exact` uma vez por scan e
marca a correspondência. Uma sondagem que estoura o tempo deixa a instalação como `system`; a
lista de códigos de saída aceitos nas receitas winget torna inofensiva uma instalação oferecida
por cima de um Node do winget.

`git`, `fnm` e `winget` são sondados como runtimes (`winget` só em alvos Windows). O fnm também
é um gerenciador de versão com o mesmo formato de status do nvm: versões gerenciadas, o alias
`default`, a versão atual e o status LTS por versão. A CLI do Cursor é encontrada pelo nome atual
do binário, `agent`, e também pelo antigo `cursor-agent`.

Um finding `prerequisite-missing` nomeia uma receita que esta máquina ofereceria e a ferramenta
de que ela precisa mas não tem. Nada instala o winget em si, então o remédio dele é um link para o
App Installer na Microsoft Store, renderizado no formato copiar-apenas em vez de um botão.

## Receitas

A tabela de receitas está descrita em
[`environment-installs.md`](../../architecture/environment-installs.md). O que importa aqui:

- **Node no Windows** usa por padrão o `OpenJS.NodeJS.LTS` do winget (instalar e atualizar; o
  pacote `.LTS` acompanha a *linha* LTS atual, então uma atualização cruza majors quando o Node
  promove uma nova). O **fnm** é o segundo gerenciador de Node assistido: instalado via winget no
  Windows, operado em toda plataforma apenas por `fnm install` e `fnm default` — nunca `fnm use`,
  que precisa de um hook de shell que um runtime iniciado como serviço não veria. Toda outra
  instalação de Node (nvm-windows, Volta, MSI do nodejs.org, Scoop, mise) é detectada, nunca
  gerenciada: o card a lista com sua origem e a ação de atualizar é copiar-apenas.
- **Atualizar e desinstalar** existem para Bun, Claude Code, Codex e Cursor. Uma receita que o
  MangoStudio executa precisa ter um formato documentado pelo fornecedor; Codex e Cursor não
  documentam desinstalação, então essas duas aparecem como comandos copiar-apenas com o motivo
  ao lado.
- **Cadeias**: "Instalar Node" em uma máquina POSIX sem nvm roda o nvm primeiro, depois o Node,
  depois define o padrão, com uma confirmação listando todos os passos e um console por passo. No
  Windows a cadeia padrão tem um passo; a alternativa com fnm tem três.

## Espelho na CLI

`mangostudio env install <receita>` e `mangostudio env update <receita>` chamam o mesmo serviço
de instalação e transmitem o mesmo log para o terminal, para quem está via SSH. Veja
[`cli.md`](../reference/cli.md).

## Adiado

Gerenciadores de Node além do winget LTS e do fnm (nvm-windows v2 quando tiver id no winget, um
`fnm.install` POSIX, classificação apenas de detecção para Scoop e mise) estão registrados em
[#1011](https://github.com/juliopolycarpo/mangostudio/issues/1011).
