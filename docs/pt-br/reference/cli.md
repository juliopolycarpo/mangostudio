# Referência da CLI

O MangoStudio é distribuído como um binário único que também funciona como CLI
para rodar e gerenciar um servidor local. Os mesmos comandos funcionam no binário
instalado (`mangostudio`) e a partir do código-fonte
(`bun run apps/api/src/index.ts <command>`).

> 🇺🇸 [English version](../../reference/cli.md)

## Canais de instalação

Escolha qualquer canal de distribuição — cada um entrega o mesmo binário
pré-compilado e sidecar do frontend. Veja a
[matriz de instalação do README](../../../README.md#install) ou:

| Canal              | Ponto de entrada                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm / bun          | `mangostudio` — veja [`packages/cli/README.md`](../../../packages/cli/README.md)                                                                                    |
| Homebrew           | `brew install juliopolycarpo/tap/mangostudio`                                                                                                                       |
| Shell / PowerShell | `install.sh` / `install.ps1` do [GitHub Releases](https://github.com/juliopolycarpo/mangostudio/releases/latest/download/install.sh) (espelhado em mangostudio.dev) |
| Scoop              | `juliopolycarpo/scoop-bucket` → `scoop install mangostudio`                                                                                                         |
| Cargo              | `cargo install mangostudio` — veja [`packages/cargo-shim/README.md`](../../../packages/cargo-shim/README.md)                                                        |
| Docker             | `ghcr.io/juliopolycarpo/mangostudio` — veja [`deployment.md`](../operations/deployment.md#docker)                                                                   |
| Manual             | Baixe arquivos de plataforma do GitHub Releases e verifique `SHA256SUMS`                                                                                            |

## Comandos

| Comando                                                                                                               | Descrição                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `mangostudio`                                                                                                         | Imprime ajuda e a lista de comandos.                                                                 |
| `serve [host\|port\|host:port]`                                                                                       | Inicia o servidor em foreground (padrão `localhost:3001`).                                           |
| `serve [host\|port\|host:port] -d`                                                                                    | Inicia o servidor em background (detached) e retorna.                                                |
| `status`                                                                                                              | Mostra se um servidor está rodando, sua URL, modo de início e saúde.                                 |
| `status --json`                                                                                                       | Emite o documento de status do hub em vez de texto simples.                                          |
| `stop`                                                                                                                | Encerra graciosamente o servidor em execução (SIGTERM).                                              |
| `restart`                                                                                                             | Reinicia o servidor do mesmo jeito que ele foi iniciado.                                             |
| `killserver`                                                                                                          | Força encerramento do servidor (SIGKILL).                                                            |
| `service <ação> [host\|port\|host:port] [--json]`                                                                     | Mantém o servidor rodando após logout e reboot.                                                      |
| `logs [-f] [-n <count>]`                                                                                              | Imprime o fim do log do servidor; `-f` acompanha.                                                    |
| `open`                                                                                                                | Abre o servidor em execução no navegador padrão.                                                     |
| `doctor`                                                                                                              | Executa diagnósticos de ambiente e configuração.                                                     |
| `doctor --all`                                                                                                        | Inclui checagens do conector ChatGPT mesmo sem conector configurado.                                 |
| `env [runtimes\|agents] [--json]`                                                                                     | Reporta runtimes, gerenciadores de versão e CLIs de agente (somente leitura).                        |
| `env install <recipe> [--environment <id>] [--version <spec>]`                                                        | Executa uma receita de instalação nesta máquina (`--environment` é sempre recusado por enquanto).    |
| `env update <recipe> [--environment <id>]`                                                                            | Igual a `env install`, restrito a receitas de atualização.                                           |
| `env toolchain [node\|bun <caminho\|auto>] [--environment <id>] [--user <email>]`                                     | Mostra ou define com qual Node e Bun os processos iniciados rodam em um ambiente.                    |
| `upgrade [--check] [--yes] [--stable \| --canary [<sha7>] \| --version <x.y.z>] [--rollback] [--no-restart] [--json]` | Atualiza esta instalação, ou entrega ao gerenciador de pacotes que é dono dela. `update` é um alias. |
| `version`, `--version`, `-v`                                                                                          | Imprime a versão embutida do MangoStudio.                                                            |

Ações de `service`: `install`, `uninstall`, `status`, `start`, `stop`,
`restart`. `install` grava uma unidade de usuário — unidade systemd
`mangostudio.service` no Linux, agente launchd `com.mangostudio.hub` no macOS,
Tarefa Agendada `MangoStudio Hub` no Windows — que roda `serve` e registra a
saída em `~/.mango/logs/service.log`.

`env install`/`env update` espelham o fluxo de instalação da página
Environments a partir do terminal: exigem `installs_enabled = true` em
`config.toml` (ou `MANGO_ENV_INSTALLS_ENABLED=true`), aceitam `--environment`
por paridade com a API — mas por enquanto sempre recusado, pois a CLI não tem
sessão para checar o `allowInstalls` de um ambiente pareado — e `--version`
para receitas que aceitam uma versão do Node. Saem com `0` em sucesso, `1` se
a execução terminar em qualquer status diferente de `succeeded`, e `2` quando
a receita nunca chega a rodar (bloqueada, não suportada, faltando um
pré-requisito, ou somente-cópia).

`upgrade` descobre primeiro **quem instalou o binário** (marcador do launcher
npm/Cargo, depois o `install-origin.json` na raiz de versões, depois o caminho
do executável) e só então age. Numa instalação feita pelos scripts, o hub
resolve o alvo, baixa e verifica o arquivo (`SHA256SUMS`, ou o `dist.integrity`
do npm para um commit canary), e executa o script de instalação embutido no seu
próprio binário com `--local`; o script move o ponteiro `current`, grava
`install-origin.json` com `origin: upgrade` e limpa versões antigas. Depois um
hub em execução é reiniciado pelo ponteiro `current`. Numa instalação por
gerenciador de pacotes (npm/bun/pnpm, Homebrew, Scoop, Cargo) o comando do
gerenciador é impresso, ou executado com `--yes` no macOS e Linux; no Windows
`--yes` entrega o comando a um processo que espera este sair. Homebrew e Scoop
são somente stable; container e checkout de código-fonte são recusados com o
comando a usar. Sem `--yes`, um terminal interativo confirma antes de baixar e
antes de reiniciar; fora de um terminal, `upgrade` só relata o que existe e sai
com `0`. Códigos de saída: `0` atualizado, já atual ou `--check`; `1`
recusado; `2` falha de download, verificação ou do script. A verificação diária
de release nova (`[updates]` no `config.toml`, `MANGO_UPDATES_CHECK`,
`NO_UPDATE_NOTIFIER`, `DO_NOT_TRACK`, `CI`) alimenta as linhas `Installed via`
e `Update` de `status` e `doctor` e o aviso na página "Esta máquina". Detalhes
na [versão em inglês](../../reference/cli.md#upgrade).

## Exemplos

```bash
mangostudio serve              # foreground em localhost:3001
mangostudio serve 3000         # foreground em localhost:3000
mangostudio serve 127.0.0.1 -d # background em 127.0.0.1:3001
mangostudio serve lan:3000 -d  # background em 0.0.0.0:3000
mangostudio service install    # inicia agora e a cada login
mangostudio restart            # reinicia do jeito que foi iniciado
mangostudio logs -f            # acompanha o log do servidor
mangostudio --version
mangostudio status
mangostudio stop
```

Para detalhes de `service` (o que a unidade roda, a lista de variáveis de
ambiente permitidas, a passagem de bastão na instalação, linger no Linux),
`restart`, `logs`, modo background, instância única, arquivos de runtime, códigos
de saída, a seção **Doctor** e configuração, consulte a
[versão completa em inglês](../../reference/cli.md).
