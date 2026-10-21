# Padrões

Como os componentes de [`components.md`](./components.md) se combinam em telas. A razão
de ser de um padrão é que a mesma situação tenha a mesma aparência em todo lugar: um aviso
na página Context e um aviso no chat são uma coisa só, desenhada uma vez. Cada regra abaixo
cita uma página que já a segue; copie essa página antes de inventar um layout.

## Páginas

Toda página tem um título `text-title` (20px/600) em `fg`. Uma descrição, quando a página
precisa de uma, fica embaixo dele em `text-sm` e `fg-muted` (`min-w-0 space-y-1` em volta do
par). As duas exceções são a saudação da Home e o título de um passo do onboarding, que são o
único `text-headline` da tela.

| Página                                    | Moldura                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio, Gallery, Terminal                 | Rolam sozinhas, com margem `p-4 sm:p-6`. Studio centraliza em `max-w-6xl`; Gallery e Terminal ocupam a largura, alinhadas à esquerda, com `gap-6 sm:gap-8`.                                                                                                                                                                |
| Home                                      | `px-4 py-8 sm:px-6`, centralizada em `max-w-6xl`, com `gap-8` entre a saudação e a grade de cards.                                                                                                                                                                                                                         |
| Settings                                  | `max-w-6xl` com `px-4 py-6 sm:px-6 lg:px-8`. A partir de `lg`, uma coluna `SettingsNav` de 14rem ao lado da página, ambas sobre `canvas`; abaixo de `lg`, a navegação empilha acima dela.                                                                                                                                  |
| Environments (e a biblioteca dentro dela) | `max-w-7xl` com `px-4 py-6 sm:px-6 lg:px-8` e `space-y-6`: o título e o subtítulo, a faixa `TabNav` e depois o conteúdo da própria aba.                                                                                                                                                                                    |
| Chat                                      | Uma coluna de leitura, `CHAT_COLUMN_CLASS` (`max-w-4xl`), compartilhada pela transcrição, pelos avisos e pelo compositor. A transcrição e os avisos ficam dentro de `CHAT_GUTTER_X_CLASS` (`px-3 sm:px-4 md:px-6`); o rodapé do compositor escreve os mesmos degraus por conta própria, com um recuo inferior equivalente. |
| Sign-in, sign-up, onboarding              | Sem shell. `BrandLockup` nomeia o produto acima do `Card` da própria página.                                                                                                                                                                                                                                               |

- **O título começa no mesmo lugar.** As páginas entre as quais a sidebar alterna
  compartilham uma margem, para que o título não pule para os lados. `md:p-8` não é uma
  margem de página (o lightbox da galeria a usa, e ele é uma sobreposição).
- **Títulos de página nunca levam um tile de ícone.** A navegação já diz onde você está;
  o título diz o que a página é.
- **Ações da página ficam na linha do título.** Add, Refresh, Import ou uma legenda como
  "Last updated" vão à direita do título, numa caixa `h-7` centralizada na linha de 28px
  dele, para que um botão de toque de 44px e uma legenda de 16px compartilhem o centro do
  título. `SettingsPage` faz isso por meio de `actions`; a linha de título da página
  Terminal faz à mão e eleva os chips dela para `h-7` para combinar.
- **Uma página oferece um destino uma vez só.** O Studio não tem um card que diga "Gallery"
  ao lado do "View all" da faixa de recentes e do item Gallery da sidebar.

## Páginas de settings

Uma página de settings é um `SettingsPage` com `SettingsSection`s, que por sua vez têm
linhas. As seções empilham com `space-y-8`; dentro de uma, o título, o aviso e o card ficam
em `space-y-3`.

- **O primeiro grupo não tem título.** O título da página já o nomeia (Appearance abre com
  uma seção sem título que reúne tema, tamanho da fonte e densidade do chat).
- **Settings salvam conforme mudam.** Não há botão Save; o `SettingsSaveIndicator` no
  cabeçalho da página informa a gravação. Por isso, uma configuração liga/desliga é um switch
  (`SettingToggle`), nunca um checkbox.
- **Uma linha por configuração** (`SettingsRow`): o nome em 14px/500 e uma dica de 12px em
  `fg-muted` à esquerda, o controle à direita. Escolha o `layout` pelo controle: `inline`
  para um switch, um checkbox, um botão pequeno ou um campo numérico; `field` para um
  `Select` ou um campo de texto; `stacked` para um slider, um textarea, um controle segmentado
  ou um caminho.
- **Uma escolha entre duas e quatro opções** é um `SettingsSegmented`; uma mais longa é um
  `Select`. Uma escolha entre registros que precisam de uma linha de descrição cada (um
  agente, o lugar onde uma chave fica guardada) é uma lista de `PickOneRow`s num
  `role="radiogroup"`.
- **Um número** é um `Input type="number"` com `w-32 text-center`, com a unidade na dica
  ("Days, 1–365"), nunca no rótulo nem depois do campo. Um intervalo de centenas de passos é
  só esse campo, porque um slider com 0.7px por passo não pode ser arrastado até um valor.
  Um intervalo grosso é um `SettingsSliderRow`; acrescente `withNumberInput` só quando a
  exatidão importa. O valor atual vai no campo numérico quando há um, ou no `readout` da
  linha quando não há, nunca nos dois.
- **Linhas que só importam quando um pai está ligado não são desenhadas enquanto ele está
  desligado.** Um arquivo de regra desligado mostra só o caminho e o switch; as linhas
  Injection role e Frequency voltam, com os valores preservados, quando ele é ligado
  (`RuleFileRows`).
- **Carregamento e falha** são `SettingsLoading` (skeletons no formato do conteúdo) e
  `SettingsLoadError` (um `Callout` `danger` com Retry), iguais em todas as páginas.
- **Um editor de registro** (um agente, um servidor MCP, um conector) é um formulário:
  `SettingsField` ou `Input` por campo, salvo por um botão explícito. Veja
  [Formulários](#formulários).

## Listas de linhas

A maioria das listas do app são linhas divididas por hairlines `stroke` dentro de um
contêiner. Nunca um card por linha, e nunca um card dentro de um card.

- **Dentro de um card.** Um `Card padded={false}` com um `<ul className="divide-y divide-stroke">`
  (a lista de provedores; acrescente `overflow-hidden` quando as linhas têm preenchimento no
  hover), ou um `SettingsSection` cujos filhos são as linhas (conectores, skills, tools). Cada
  linha aplica o próprio `px-4 py-3`.
- **Fora de um card** (as alterações, o histórico, as worktrees e os stashes do painel do
  workspace): `RowList` (`features/workspace/components/RowList.tsx`), uma caixa `rounded-md`
  com hairline, sem preenchimento próprio e com linhas `divide-y divide-stroke`. A lista de
  sessões da página Terminal escreve as mesmas classes à mão.
- **Um registro de várias linhas** (um arquivo de regra de prompt, um servidor MCP com suas
  tools) é um card cada, empilhados com `space-y-3`: `SettingsSection cards`, ou os próprios
  cards, como `McpSettingsPage` os lista. A borda do card separa registros; o hairline separa
  as linhas dentro de um.
- **Anatomia da linha.** O nome em `text-sm` (`font-semibold` quando a linha é um registro
  com título próprio, como um provedor ou um conector), badges na mesma linha, quebrando para
  baixo dele numa tela estreita, e depois uma linha de resumo em `text-xs` `fg-muted`.
- **Uma linha que navega** é um `Link` de largura total com `hover:bg-fill-hover`, um anel de
  foco interno (`focus-visible:-outline-offset-2`, para que o card não o corte) e um
  `ChevronRight` no fim, em `ICON_MD` e `fg-subtle` (`ProviderSettingsRow`). Uma linha que só
  navega não tem ações de linha.
- **A linha atual** é `fill-selected` com `SELECTION_BAR` e o nome em 500, como na sidebar e
  na lista de sessões da página Terminal.

## Menus e ações de linha

- **Uma ou duas ações** numa linha são botões no fim dela: `Button size="icon-sm"` para um
  ícone, `size="sm"` para uma palavra. Uma destrutiva é `subtle-danger`, que repousa em
  `fg-muted` para que uma lista não termine numa coluna de vermelho. Um botão só de ícone
  leva tanto `aria-label` quanto `title`.
- **Ações reveladas no hover** (renomear e excluir na sidebar, Rename e Pop out na aba do
  terminal) também são reveladas no foco (`group-focus-within:`), e uma tela de toque, que
  não tem hover, as mostra em repouso (`pointer-coarse:inline-flex`, ou
  `pointer-coarse:flex` para o grupo da sidebar). Numa lista longa em que todas as linhas
  passariam a levá-las (a sidebar), só a linha atual as leva.
- **Mais do que isso** vai para um único `Menu` `⋮`, com a ação frequente do lado de fora.
  Uma linha de servidor MCP tem Test, o switch dela e um menu com Edit, Rename…, Reset to
  default, um separador e então Delete server.
- **Dentro de um menu**, todo item tem o seu glifo `ICON_MD`, o mesmo glifo que a ação usa
  em outros lugares (Trash2 para excluir, RotateCcw para descartar). Um item que abre um
  diálogo ou pede mais informação termina em `…` ("Rename…", "Stashes…", "Amend latest
  commit…"). Uma preferência liga/desliga é um item `checked`, não um segundo menu. Um item
  destrutivo vai por último, depois de um `MenuSeparator`, com `tone="danger"`, e abre um
  `ConfirmDialog` em vez de agir direto do menu.
- **Uma falha vinda de um item de menu** não tem linha onde aparecer depois que o menu
  fecha, então vira um toast (o reset de `ToolIdentityMenu`), não silêncio.

## Formulários

- **Um campo por linha**, na largura total do contêiner: `Input` com os próprios `label`,
  `hint` e `error`, ou `SettingsField` em volta de um controle que não tem rótulo próprio
  (`Select`, `Textarea`, uma lista de linhas). O rótulo fica em 14px/500 acima do controle, a
  dica em 12px `fg-muted` abaixo dele. Um erro substitui a dica, em `danger` com um `CircleX`
  em `ICON_SM`, e o campo passa a borda para `danger` (`aria-invalid`).
- **Um placeholder é um exemplo**, nunca a instrução e nunca o rótulo. O que o campo espera
  (um formato, um intervalo, uma unidade) é a dica.
- **Espaçamento.** Os campos de um diálogo ficam no `space-y-4` do corpo. Um formulário de
  página (sign-in, sign-up) separa seus grupos com `space-y-5` e os campos dentro de um grupo
  com `space-y-3`. Um número curto (dias, segundos) também é `w-32 text-center` aqui, como o
  Expires in no diálogo de chave de API.
- **Onde um formulário mora.** Num `Dialog` (`md`), ou num único `Card` numa página sem
  shell. Nunca dois cards lado a lado para deixar um formulário mais largo.
- **Ações.** No rodapé de um diálogo, alinhadas à direita na largura natural: Cancel
  `secondary` primeiro, o verbo `primary` por último. Enquanto a requisição está em
  andamento, o botão principal mostra `loading` e o rótulo passa para a forma progressiva
  ("Creating…"), Cancel fica desabilitado e `closeDisabled` impede o Escape e o fundo. O único
  envio de um formulário de página é um botão principal `lg` de largura total.
- **Uma falha no envio** vai no slot `notice` do diálogo como um `Callout` `danger`, para
  continuar visível acima do rodapé. Um problema de campo vai no campo.
- **Campos opcionais.** Ainda não há uma convenção única. Um formulário com vários campos
  opcionais os agrupa sob uma legenda `MicroLabel` ("Optional", como faz o diálogo de
  adicionar ambiente); um campo opcional isolado diz isso no rótulo ("Organization ID
  (optional)"). Veja [as pendências em aberto](./migration.md#pendências-em-aberto).
- **Liga/desliga num formulário.** Uma configuração com efeito imediato é um `Toggle`; uma
  opção enviada com o formulário é um `Checkbox`, ou um `CheckboxRow` numa lista de escolha
  múltipla.

## Linhas com um controle

A linha de settings comum: o título (`text-sm`, 500) e a dica (`text-xs`, `fg-muted`) à
esquerda e o controle à direita, `gap-4`, `px-4 py-3`, `stroke` entre as linhas. O controle é
um `Toggle`, um `Select`, um campo numérico `w-32` ou um `Button size="sm"`. `SettingsRow` a
desenha; veja [Páginas de settings](#páginas-de-settings) para saber como escolher o layout.

## Avisos

Use `Callout` para tudo que a pessoa deve ler no próprio fluxo da página.

| Situação                                            | Tom                 |
| --------------------------------------------------- | ------------------- |
| Algo falhou e a pessoa precisa agir                 | `danger` + uma ação |
| A pessoa talvez queira fazer algo, nada quebrou     | `warning`           |
| Um fato que vale saber, uma nota sobre um resultado | `info`              |
| Um passo concluído que continua na tela             | `success`           |
| Contexto neutro                                     | `neutral`           |

- **Um aviso que exige ação da pessoa traz a ação**: um botão `secondary` `sm` no slot
  `action` (Retry, Edit, Read the notice). Numa região estreita como o painel do workspace
  (280px no mínimo), o slot espremeria o texto numa coluna, então a ação vai abaixo do corpo
  (`TerminalUnavailableNotice`).
- **O detalhe bruto é secundário.** Uma falha diz o que falhou e o que fazer no título e no
  corpo; o erro bruto de transporte ou do servidor vem depois como detalhe em
  `font-mono text-xs` (a falha de conexão do servidor MCP).
- **Um resultado discreto dentro de uma linha** (um teste que passou, uma entrada ignorada)
  é um `StatusNote`: um glifo de status e palavras esmaecidas, sem preenchimento.
- **Um toast** serve para algo que já aconteceu e não precisa de acompanhamento ("Copied"),
  ou para uma falha que não tem onde aparecer no fluxo. Ele surge no canto superior direito,
  abaixo do cabeçalho.
- Nunca pinte as palavras de um aviso; o glifo e o preenchimento carregam o tom.

## Status

Mostre o estado como um `Badge` (uma palavra numa pílula), um `StatusDot` ao lado de uma
palavra, ou um glifo na cor de status **com** uma palavra. A cor sozinha nunca é o sinal.

- Prefira um badge `neutral` para "sem estado" a omiti-lo: uma linha que às vezes tem badge e
  às vezes não parece quebrada.
- **Escolha o tom pelo que a pessoa pode fazer a respeito.** Algo que simplesmente está
  ausente e é opcional (uma CLI de agente não instalada, uma tool opcional) é `neutral`. Algo
  que a pessoa pode resolver (sessão encerrada, aguardando aprovação) é `warning`. `error` é
  para uma falha. A página inicial de uma conta saudável não mostra vermelho nem âmbar.
- Quando uma lista mistura os três, ordene-a pelo que ela pede da pessoa: o que precisa de
  ação, o que pode esperar e depois o que só vale saber (a página de saúde de Environments:
  "Needs action", "Can wait", "For information"). Quando nada precisa de ação, diga isso numa
  linha esmaecida em vez de um estado vazio, porque a lista abaixo dela não está vazia.

## Diálogos e ações destrutivas

- **Tamanho pelo conteúdo.** `sm` para uma pergunta, `md` (o padrão) para um formulário ou
  uma lista curta, `lg` para passos, uma tabela de comandos ou um wizard.
- **Confirme só o que é irreversível ou custoso**, com `ConfirmDialog`: um título em forma de
  pergunta ("Revoke this API key?"), uma frase que nomeia a consequência, o nome da coisa
  entre aspas abaixo dela quando o título não o cita, e então Cancel e o verbo destrutivo num
  botão `danger`. O verbo repete a pergunta ("Revoke"), nunca "OK" ou "Yes".
- **O foco cai em Cancel** nas confirmações destrutivas; o Escape e o fundo cancelam.
- **Uma mudança que a pessoa pode desfazer no lugar** (um switch, uma renomeação) é feita na
  hora, sem diálogo.
- **Um diálogo que não pode ser perdido por acidente** (a exibição única da chave de API)
  passa `closeDisabled` e oferece uma única saída (Done). Um wizard (o `WizardFrame` da
  biblioteca) mantém Cancel no rodapé em todos os passos antes do resultado, com Back ao lado,
  e termina com Done.
- **A resposta segura** é "Cancel", ou nomeia o que é mantido quando a pergunta é sobre perder
  algo no git: "Keep branch", "Keep stash", "Keep worktree".

## Vazio, carregamento e erro

- **Vazio**: `EmptyState` com um ícone `ICON_LG`, o que está faltando e como conseguir. Numa
  página de settings, ele fica num `Card padded={false}`. Ofereça a saída uma vez só: ou como
  a própria `action` do estado vazio (um botão `secondary` `sm` com um `Plus` em `ICON_SM`),
  caso em que o botão do cabeçalho que faz a mesma coisa não é desenhado enquanto ele aparece
  (Connectors, Custom rules, Agents), ou só pelo botão do cabeçalho, sem ação no estado vazio
  (MCP servers). Onde não há nada a fazer (Logs, Metrics), não há ação. Um fato permanente que
  não é uma lista vazia (um repositório só com a worktree principal) é uma linha de texto em
  `fg-muted`, não um título de `EmptyState`.
- **Indisponível**: uma feature que não pode funcionar aqui (a CLI do GitHub está sem login,
  os terminais estão desligados) não é uma lista vazia. É um `Callout`, `warning` quando a
  pessoa pode resolver ou esperar passar e `info` quando é um fato permanente, alinhado à
  esquerda onde o conteúdo estaria, dito uma vez para a região que cobre. Os controles que ele
  torna inertes (filtros, um botão de criar, um cabeçalho "Sessions" sem nada embaixo) não são
  desenhados ao lado dele; uma lista que continua acessível (terminais abertos no limite)
  permanece. O título nomeia a causa ("Terminal limit reached", não apenas "Terminal is
  unavailable").
- **Carregando**: blocos `Skeleton` no formato do conteúdo para listas e cards (a grade de
  skeletons da galeria usa o mesmo `GALLERY_GRID` dos tiles, então nada pula); `Spinner` para
  uma ação isolada. Nunca os dois na mesma região. Um spinner sozinho recebe um `label`, para
  ser um `role="status"` com nome.
- **Erro**: um `Callout tone="danger"` com a causa e um `Button` Retry. Um toast não é um
  estado de erro.
- **Estados de página inteira** compartilham uma anatomia: um `Card` centralizado sobre
  `canvas` (`max-w-md`) com um título `text-title`, uma frase em `fg-muted` e a saída. O Not
  Found traz o `Logo` dentro do card, porque nenhum shell nomeia o produto; a falha de
  inicialização abre com um `CircleX` `danger` em `ICON_LG` e Retry, e ocupa ou a superfície
  inteira ou a região de conteúdo do shell. A espera antes da primeira renderização é um
  `StartupSpinner`: um `Spinner` com rótulo, sozinho sobre `canvas`.

## Textos

Todo texto da interface vem de `@mangostudio/shared/i18n`, com `en` e `pt-BR` mantidos
exatamente com as mesmas chaves **(testado)**. `apps/shared/tests/unit/i18n-copy-rules.test.ts`
cobra dos dois dicionários as regras marcadas **(testado)**; as demais ficam a cargo da revisão.

- Só a primeira letra maiúscula (sentence case) em botões, títulos, abas, itens de menu e
  badges: "New chat", "Create pull request", "External agents". Os badges de alteração de
  arquivo são renderizados exatamente como escritos, então ficam com inicial maiúscula no
  dicionário **(testado)**. O único texto em caixa alta é o `.micro-label`, aplicado por CSS.
- Botões são verbos ou substantivos curtos: "Send", "Stop", "Create pull request". Numa
  confirmação, repita o verbo da pergunta.
- A reticência é o caractere único `…`, nunca três pontos **(testado)**: "Saving…",
  "Search chats…", "Rename…".
- Um nome citado numa frase usa aspas tipográficas, nunca a reta `"`:
  `Could not connect to “{name}”`, `No results for “{query}”`. Um apóstrofo é o tipográfico
  `’` ("Don’t have an account?").
- Uma palavra por conceito. Uma sessão com um runner é um **chat**. O produto é
  **MangoStudio**, uma palavra só **(testado)**.
- Uma contagem nunca é "chat(s)". Uma mensagem com contagem é um par de chaves, `xOne` e
  `xOther` (`sessionsOne`: "{count} chat", `sessionsOther`: "{count} chats"), escolhido com
  `usePlural` (ou `pluralMessage` fora de um componente), para que cada idioma faça a
  concordância de substantivos e adjetivos do seu jeito ("1 arquivo alterado", "3 arquivos
  alterados").
- Erros dizem o que falhou e o que fazer: "Could not start the chat on that runner. Try
  again."
- Um valor com unidade põe a unidade na dica ou no readout, não no rótulo.
- Nada de emoji na interface.

## Densidade

O chat tem três densidades (compact, default, comfortable) que mudam só os espaços entre
turnos e entre passos (`[data-chat-density]` em `index.css`). Alturas de controle, raios e
tipografia não mudam com a densidade: um chat compacto não é uma interface menor.
