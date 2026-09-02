# Terminal Ao Vivo

O MangoStudio consegue abrir um shell interativo real na máquina que um ambiente descreve e
mostrá-lo no navegador: como um painel **Terminal** na barra lateral do chat, ou em uma janela
própria a partir de `/terminal`. Várias sessões podem rodar ao mesmo tempo. O shell roda onde o
runtime do ambiente roda — Local, stdio, WSL, SSH, contêiner ou máquina pareada — nunca no hub
por exceção.

## Onde cada coisa roda

| Responsabilidade                                                  | Dono                     |
| ----------------------------------------------------------------- | ------------------------ |
| O PTY, o processo do shell, seu ambiente e seu ciclo de vida      | Runtime (`apps/runtime`) |
| Quem pode abrir uma sessão, o registro, limites, expiração ociosa | Hub (`apps/api`)         |
| Retransmitir bytes ao navegador e controle de fluxo por socket    | Hub (`apps/api`)         |
| Formato da sessão, enquadramento do socket, limites               | Shared (`apps/shared`)   |
| Renderização, teclas, redimensionamento, confirmações             | Frontend (xterm.js)      |

O runtime inicia o shell com `Bun.spawn({ terminal })`, inline a cada spawn, para que o shell
seja líder de sessão e controle seus próprios jobs. Não há addon nativo para distribuir. O runtime
guarda os últimos 256 KiB de saída de cada sessão para que um visualizador que volte veja onde
estava.

## Protocolo

Oito métodos do runtime carregam a sessão — `terminal.open`, `attach`, `detach`, `write`,
`resize`, `ack`, `close`, `list` — e um tópico de evento, `terminal.output`, transmite bytes ao
hub chaveados pelo id de sessão cunhado pelo hub. Todo método exige a capacidade `shell`; uma
máquina `readonly` recusa todos eles, inclusive a listagem. O runtime anuncia `terminal: true`
no manifesto e no relatório de saúde apenas quando o dono concedeu `shell`, existe um shell e o
build consegue abrir um PTY. Ausente significa indisponível.

O runtime nunca emite `terminal.output` antes de um hub chamar `terminal.attach` naquela sessão.
Essa invariante é o que torna o tópico aditivo: um hub antigo demais para decodificar o payload
nunca o recebe.

O navegador conversa com `/api/terminal/:id`, uma rota WebSocket própria. `/api/ws` continua
apenas para invalidações. Os frames são binários com um byte de tipo como prefixo: cliente
`data`, `resize`, `ack`, `ping`; servidor `data`, `exit`, `notice`, `pong`. O codec vive em
`@mangostudio/shared/terminal`.

## Controle de fluxo

As opções de socket que toda rota WebSocket do hub compartilha fecham a conexão com 64 KiB de
backpressure em vez de desacelerá-la, e `Bun.Terminal` não consegue parar de ler o PTY. Por isso
o controle de fluxo é explícito e vive em três lugares:

- **Navegador.** Depois que o xterm.js interpreta um bloco, o cliente confirma os bytes. As
  confirmações são agrupadas, não enviadas por frame.
- **Hub.** As confirmações são repassadas ao runtime como `terminal.ack`. O relay mantém uma
  fila própria por socket, envia apenas enquanto a quantidade em buffer do socket fica abaixo de
  48 KiB, retoma no drain e, passando de 1 MiB enfileirado, descarta os bytes mais antigos e envia
  um aviso `queue_overflow`.
- **Runtime.** A emissão é controlada por crédito: no máximo 256 KiB podem estar em voo sem
  confirmação. A saída além da janela espera em um buffer pendente de 1 MiB; passando disso, os
  bytes mais antigos são descartados e um marcador `dropped` sai quando o fluxo retoma. O terminal
  o desenha como uma linha esmaecida.

Um loop de `yes` custa, portanto, memória limitada em cada salto, e o servidor nunca fecha o
socket por ele ser rápido.

## Sessões

As sessões pertencem ao runtime e sobrevivem ao socket do navegador. Fechar o painel ou trocar
de aba desanexa; anexar de novo reproduz o scrollback. Um visualizador segura uma sessão por vez:
abri-la em uma janela a tira da barra lateral, que então oferece trazê-la de volta.

Uma sessão termina quando o usuário a fecha, quando fica sem visualizador por
`idle_timeout_minutes`, quando a conexão do runtime cai ou quando o hub para. O registro do hub
fica em memória; sessões não sobrevivem a um reinício do hub.

## Quem pode abrir uma

A mesma capacidade de `shell.run`: `allow.shell` no runtime. No runtime **Local** — o processo e
a conta de SO do próprio hub — um terminal exige adicionalmente a atestação `single-user-host`
que o caminho de agentes externos já calcula. Um segundo usuário do MangoStudio no mesmo hub
fecha todo terminal Local e recusa novos com `TERMINAL_NOT_ISOLATED`.

O ambiente do shell é o do próprio runtime com variáveis com cara de segredo removidas exatamente
como `shell.run` as remove, mais `TERM=xterm-256color`, `COLORTERM=truecolor` e
`MANGOSTUDIO_TERMINAL=1`. O log de auditoria registra o shell, o diretório de trabalho e o
tamanho em `terminal.open`; teclas nunca são gravadas.

## Configuração

```toml
[terminal]
enabled = true
idle_timeout_minutes = 30
max_sessions_per_user = 8
scrollback_kib = 256
```

Ambiente: `MANGO_TERMINAL_ENABLED`, `MANGO_TERMINAL_IDLE_TIMEOUT_MINUTES`,
`MANGO_TERMINAL_MAX_SESSIONS_PER_USER`, `MANGO_TERMINAL_SCROLLBACK_KIB`. Com `enabled = false`
o painel fica oculto e aberturas respondem `TERMINAL_DISABLED`.

## Limites e erros

| Recusa                                     | Código                  |
| ------------------------------------------ | ----------------------- |
| Terminais desligados no hub                | `TERMINAL_DISABLED`     |
| Limite por usuário atingido                | `TERMINAL_LIMIT`        |
| Runtime Local em um hub multiusuário       | `TERMINAL_NOT_ISOLATED` |
| Runtime não oferece PTY, ou o dono recusou | `UNSUPPORTED`           |

`GET /api/terminals/availability?environmentId=…` responde todas essas antes de alguém digitar,
para que o painel explique em vez de falhar na abertura. Ambientes em contêiner precisam de um
shell na imagem; o painel diz isso.

## Windows

Sessões em um runtime Windows usam ConPTY pelo Bun com PowerShell (`pwsh` preferido,
`powershell.exe` como alternativa). Redimensionar funciona. Lacunas conhecidas herdadas do
suporte a ConPTY do Bun: sem `SIGWINCH` nos filhos, a saída é recodificada e `close()` pode
bloquear em builds do Windows anteriores ao 11 24H2 enquanto um filho ainda roda — o runtime mata
a árvore de processos primeiro. Este repositório não tem uma lane de testes unitários no Windows,
então o ramo PowerShell é entregue por leitura de código; o caminho POSIX é coberto por testes
com PTY real.
