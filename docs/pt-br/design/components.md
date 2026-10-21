# Componentes

Os componentes compartilhados em `apps/frontend/src/components/ui/`, `components/settings/` e
`components/layout/`, algumas peças que pertencem a uma feature mas que outras features copiam
(indicadas com o seu arquivo), e as partes do chat que carregam o dialeto próprio do produto
(composer, timeline). Os nomes de token e as utilities estão definidos em
[`foundations.md`](./foundations.md). Use um destes componentes antes de repetir as classes dele.
Se você precisa de uma variante que não existe, adicione-a ao componente, não ao ponto de uso.

Cada entrada traz o propósito do componente, suas variantes e tamanhos, as props que mudam a
aparência ou o comportamento, e o seu contrato de acessibilidade. Os tamanhos de ícone são as
três constantes de `lib/icon-sizes.ts`: `ICON_SM` (14px), `ICON_MD` (16px) e `ICON_LG` (20px).

## Ações

### `Button`

O único botão (`ui/Button.tsx`): flat, peso 500, `rounded-sm`, com transição apenas de cor.
Hover e press mudam o preenchimento. Não há sombra, nem escala ao pressionar, nem brilho.

| `variant`       | Preenchimento                                                           | Uso                                                             |
| --------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `primary`       | `accent`, texto `on-accent`                                             | **Um** por região: Send, Save, New chat. O padrão.              |
| `secondary`     | `control` + borda `stroke`                                              | Ao lado do primário: Cancel, Discard. A ação de um empty state. |
| `subtle`        | nenhum; hover `fill-hover`, press `fill-pressed`                        | Toolbars, o header, ações de linha, botões de ícone.            |
| `subtle-danger` | nenhum, texto `fg-muted`; ao ser alcançado: `danger` em `danger-subtle` | Uma ação destrutiva que não é a confirmação final.              |
| `danger`        | `danger-solid`, texto `on-danger`; o hover clareia                      | A confirmação final de algo destrutivo, dentro de um diálogo.   |

| `size`    | Caixa | Uso                                                                                                     |
| --------- | ----- | ------------------------------------------------------------------------------------------------------- |
| `sm`      | 28px  | Barras e linhas densas; texto a 12px, glifo `ICON_SM`.                                                  |
| `md`      | 32px  | O padrão; texto a 14px, glifo `ICON_MD`.                                                                |
| `lg`      | 40px  | A ação principal de sign-in, sign-up e onboarding; Back e Skip do onboarding têm a mesma altura.        |
| `icon`    | 32×32 | Um botão só de ícone.                                                                                   |
| `icon-sm` | 28×28 | Um botão só de ícone numa linha densa: renomear e excluir da sidebar, o download de um tile da galeria. |

- **`loading`** mostra um spinner, desabilita o botão, define `aria-busy` e mantém a cor da
  variante, para que "trabalhando" nunca pareça "indisponível".
- **Disabled** não é a variante esmaecida. `primary`, `secondary` e `danger` viram um tile
  cinza neutro (`fill-selected` + `fg-subtle`, sem borda). `subtle` e `subtle-danger` não têm
  tile para ficar cinza, então só passam o texto para `fg-subtle`
  ([decisões 10 e 14](./decisions.md)): um controle inativo não pode parecer o controle em
  hover ou o selecionado.
- **`subtle-danger`** (Remove, Revoke, Delete numa linha) repousa em `fg-muted` e passa para
  texto `danger` sobre um preenchimento `danger-subtle` no hover, no foco por teclado e no press
  ([decisão 22](./decisions.md)). Ele repousa discreto porque se repete: uma lista em que toda
  linha termina numa lixeira vermelha vira uma coluna de vermelho que grita mais alto que as
  linhas. Nunca é um botão `subtle` com override `text-danger`, que perde o estado de press e
  faz um hover neutro ao lado dos irmãos.
- **Acessibilidade.** Um botão só de ícone leva um `aria-label`; um botão `subtle-danger` só de
  ícone leva `aria-label` e `title`, para que o verbo também seja descoberto pelo ponteiro. Num
  ponteiro grosso (coarse) todo botão cresce até o piso de toque de 44px
  ([decisão 15](./decisions.md)).

`buttonClassName(variant, size)` devolve as mesmas classes para algo que precisa parecer um
botão mas não pode ser um `<button>`: um `<Link>` do router, um `<a>` de download.

### `SplitButton`

Uma ação primária com um menu das suas variações acoplado ("Commit" / "Commit and push"). Use-o
só quando as alternativas forem variações da mesma ação.

- As duas metades são `Button size="sm"`; o divisor é uma linha de 1px `accent-pressed`.
- Enquanto a metade primária está desabilitada, ela fica no cinza neutro de qualquer botão
  desabilitado, então o chevron cai para `secondary` e o divisor para a borda `stroke` dele: o
  menu não pode ser a única manga na região. Uma metade primária que está apenas em `loading`
  mantém o accent, e o chevron também.
- `menuDisabled` é separado de `disabled`, porque as ações do menu têm pré-condições próprias.
  `menu` recebe filhos `MenuItem` e `MenuSeparator`; `open` e `onOpenChange` são controlados.
- **Acessibilidade.** `menuLabel` é o `aria-label` e o `title` do chevron.

### Controles Sobre Uma Imagem (`MEDIA_CONTROL_CLASS`)

Um controle colocado sobre o véu `scrim-media` (o Close do lightbox da galeria, o download de um
tile da galeria) é um botão `subtle` mais `MEDIA_CONTROL_CLASS`
(`features/gallery/components/media-control.ts`). O véu é o mesmo preto nos dois temas, porque
uma fotografia não tem tema, então o controle também não pode ter: o glifo é `on-scrim-media`,
hover e press são `fill-media-hover` e `fill-media-pressed`, e o outline de foco é
`on-scrim-media`, já que o `focus` escuro do tema claro sumiria sobre o véu. Não use `secondary`
ali: o preenchimento `control` dele segue o tema e desenhava um tile branco vivo sobre o preto
no tema claro. O Download do lightbox continua `primary`, com o mesmo outline de foco
`on-scrim-media` ([decisão 23](./decisions.md)).

## Entrada

### `Input`

Um campo de texto de 32px: preenchimento `control`, borda `stroke` em três lados e
`stroke-strong` embaixo (a linha que diz "isto é um campo"). O hover vai para `control-hover`. O
foco troca a borda por `focus` e adiciona um anel de 1px. Disabled esmaece para 50%.

- **`label`** fica acima do campo, em 14px/500, e está sempre visível.
- **`hint`** fica abaixo do campo, em 12px `fg-muted`. É a instrução ("Days, 1–365"), coisa que
  um placeholder nunca é.
- **`error`** define `aria-invalid`, deixa a borda `danger` e substitui o hint pela mensagem e
  por um glifo `CircleX`. Um campo mostra uma mensagem por vez.
- **`placeholder`** é um valor de exemplo em `fg-subtle`, nunca a instrução.
- **Acessibilidade.** O label é um `<label htmlFor>`. O hint ou o erro é adicionado ao
  `aria-describedby` do campo, depois de qualquer id que o chamador passe.

`FIELD_CLASS` é a string de classes do campo, exportada para que um campo inline (a busca da
sidebar, um input de renomear, a navegação recolhida de settings) tenha a mesma cara.

### `Textarea`

Um campo de várias linhas com a mesma cara (`FIELD_CLASS`), com pelo menos 96px de altura
(`min-h-24`), redimensionável só na vertical. Mono para um prompt ou outro texto técnico é um
`className` no ponto de uso. Não tem prop `label`: nomeie-o com `SettingsField` ou com um
`<label htmlFor>`.

### `Select`

O dropdown de formulário: a cara do `Input` com um `ChevronDown` em `fg-muted`. Ele substitui o
`<select>` nativo, cujo popup desenhado pelo sistema operacional nenhum CSS consegue estilizar.

- A listbox é um `.dropdown-panel` renderizado em `document.body` e posicionado à mão abaixo do
  trigger, para que um diálogo com scroll não consiga cortá-la. A altura máxima é 256px. Ela
  abre acima do trigger só quando há menos de 96px livres abaixo e mais espaço livre acima.
- As linhas têm 32px a 14px, com uma linha opcional de `description` em 12px `fg-muted`. O hover
  e o cursor do teclado usam `fill-hover`, a opção selecionada usa `fill-selected` e peso 500, e
  o único accent é o check em `accent-fg`. Uma opção desabilitada esmaece e não pode ser
  escolhida. Uma lista longa rola com a `app-scrollbar` fina.
- `placeholder` aparece quando `value` não corresponde a nenhuma opção (um modelo que o catálogo
  não lista mais).
- **Acessibilidade.** O trigger é `role="combobox"` com `aria-expanded` e
  `aria-activedescendant`; o foco fica nele enquanto as setas movem o cursor. Nomeie-o com `id`
  mais um `<label htmlFor>`, ou com `ariaLabel`.

### `ChipSelect`

O dropdown `key: value` do composer: um trigger `.composer-chip` (com no máximo 13rem de
largura) com um `icon` opcional, um `adornment` (um status dot) e um `label` como chave. Ele
compartilha o modelo de teclado e a anatomia de linha do `Select`, para que dois menus abertos
da mesma faixa combinem.

- **`placement="above"`** (o padrão) abre um `ComposerPopover`, ancorado 8px acima do shell do
  composer, com a borda esquerda alinhada ao chip. Use-o no composer, no pé da viewport.
- **`placement="below"`** abre um painel pendurado no chip. Use-o no header ou na linha de
  título de uma página, onde um painel para cima abriria acima da janela e seria cortado.
- O painel rola depois de metade da viewport (`max-h-[50vh]`) com a `app-scrollbar` fina.
  `panelClassName` define a largura dele (`w-56` por padrão).
- Um chip aberto ganha `fill-selected`. Um chip desabilitado esmaece para 50%; quando a resposta
  dele estiver decidida de vez, use `LockedChip` no lugar.
- **Acessibilidade.** `ariaLabel` é obrigatório, porque o texto visível de um chip é um
  fragmento. `describedBy` e `title` são repassados para o trigger.

### `Checkbox` E `Radio`

`Checkbox` é uma caixa de 16px com `rounded-xs` e borda `stroke-strong`; marcado, ele preenche
com `accent` e um tick `on-accent`. `Radio` é a mesma caixa com face redonda e um ponto
`on-accent`, para que os dois se leiam como uma família. Os dois mantêm um input real com
`appearance: none` em vez de um proxy escondido, para que a coisa que o ponteiro atinge seja a
coisa que o navegador marca.

- Disabled esmaece o controle inteiro para 50% (no wrapper, para que tick e caixa esmaeçam
  juntos).
- **Toque.** A caixa de 16px não cresce: o piso de 44px a ignora. Um pseudo-elemento no input
  amplia a área de toque para 40px, então um toque ao lado da caixa ainda a alterna, com ou sem
  um `<label>` em volta.
- **Acessibilidade.** Dê a cada um um `<label>` ou um `aria-label`.

### `Toggle` E `ToggleSwitch`

O switch de preferência: um trilho de 36×20 com um knob de 12px. Desligado é `control` com
borda `stroke-strong` e um knob `fg-muted` que vira `fg` no hover; ligado é `accent` com um knob
`on-accent`. O knob não cresce e não tem sombra. Disabled esmaece o trilho para 50%.

- `ToggleSwitch` é o switch puro, para uma linha que é ela própria o `<label>`
  (`SettingToggle`, a linha de caminho de um arquivo de regras).
- `Toggle` adiciona seu próprio label de 14px à direita. Ele gera o id do input, então dois
  toggles com o mesmo label continuam distintos; passe `id` só quando outra coisa precisar
  referenciar o input.
- Use um switch para uma configuração que vale na hora, e um checkbox para uma opção num
  formulário ou numa lista.
- **Acessibilidade.** O input é um checkbox visualmente escondido com `role="switch"`; o
  outline de foco é desenhado no trilho. Um `ToggleSwitch` puro precisa de um `aria-label`.

### `SettingsSegmented`

Uma linha de dois a quatro segmentos mutuamente exclusivos (`components/settings/`): a cara de
32px `rounded-sm` de um botão secundário, preenchimento `control` e texto `fg-muted` em repouso.
O segmento selecionado é um `fill-selected` neutro com borda `stroke-strong`, texto `fg` e uma
barra `accent` de 2px ao longo da borda de baixo, a marca da aba sublinhada atual. Nunca é o
preenchimento accent de um botão primário, que colocaria um segundo primário ao lado de Save
([decisão 16](./decisions.md)). Uma lista mais longa pertence a um `Select`.

- **`kind="buttons"`** (o padrão): botões pressionados e não pressionados (`aria-pressed`) num
  grupo nomeado por `ariaLabel`, para uma escolha que vale na hora.
- **`kind="radio"`**: um grupo de radios nativo (`role="radiogroup"`, as setas movem a escolha)
  para uma escolha dentro de um registro, como o papel e a frequência de um arquivo de regras.
  Passe um `name` único na página.

### `PickOneRow`

Uma entrada de uma lista em que exatamente uma é a atual (`components/settings/`): um agente a
editar, o lugar onde uma chave fica guardada. Use-o para qualquer lista de escolha única cujas
entradas precisem de mais que uma palavra: o "how do you reach it" do diálogo de adicionar
ambiente, a lista de distribuições WSL, o container engine, o estado final do onboarding e o
"Choose who answers" do setup wizard usam todos ele. O tile com borda e check que ele substituiu
não existe mais. Ele não serve para um conjunto curto de rótulos (`SettingsSegmented`: os
perfis de consentimento, o modo de avatar) nem para uma lista de escolha múltipla
(`CheckboxRow`).

- **Anatomia.** Uma linha `rounded-sm` com um hairline `stroke`: um `icon` de 16px em
  `fg-muted`, um `title` a 14px (500 enquanto atual) e uma linha de `description` de 12px em
  `fg-muted`. A descrição é truncada, e uma descrição em string também vira o tooltip `title`
  da linha.
- **Atual.** A marca da navegação: `fill-selected` e a barra `accent` de 3px
  (`SELECTION_BAR`).
- **Superfície.** As outras linhas são `control` (dentro de um card ou de um diálogo) ou
  `surface` com `onCanvas` (direto na página), cada uma com seu preenchimento de hover.
- **`disabled`** é uma escolha que aparece na lista mas não pode ser feita. Ela não esmaece,
  porque o nome dela é informação ([decisões 17 e 21](./decisions.md)): o glifo mantém a força
  (o dot de identidade de um agente continua no seu matiz), o nome desce de `fg` para
  `fg-muted`, o hover some, o cursor é `not-allowed` e o radio não recebe foco. A linha diz o
  porquê, na descrição ou num `Badge` de status ao lado do nome (`warning` para um sign-in que a
  pessoa consegue resolver).
- **`testId`** vai para o input radio, o elemento que fica marcado e desabilitado.
- **Acessibilidade.** A linha é um `<label>` em volta de um radio visualmente escondido; todas as
  linhas de uma lista compartilham o `name`. Envolva as linhas num `role="radiogroup"` com um
  `aria-label` que nomeie a escolha: uma parada de Tab, as setas movem a escolha, e um leitor de
  tela ouve uma escolha em vez de um conjunto de toggles.

### `CheckboxRow`

Uma opção numa lista de escolha múltipla (`components/settings/`): um `Checkbox` e o seu `label`
de 14px/500 numa linha `control` com um hairline `stroke`, com a linha inteira como alvo do
clique. Uma `description` opcional é uma segunda linha técnica em mono 11px `fg-muted` (um
identificador, um slug). A caixa marcada é o único accent, para que uma tela cheia de linhas
continue neutra. Disabled esmaece a linha para 50%, uma vez só (a caixa dentro dela não esmaece
uma segunda vez).

### `ChoiceButton`

Uma resposta num card de pergunta ou de formulário no chat
(`features/chat/components/ChoiceButton.tsx`, usado por `QuestionCard` e `ElicitationCard`).
Uma linha `rounded-sm` com borda cuja face de 16px à esquerda diz o que um clique faz:
`kind="one"` desenha uma face redonda (escolha uma), `kind="several"` uma quadrada (escolha
várias), as formas de `Radio` e `Checkbox`. Escolhida, a face preenche com `accent` (um ponto ou
um tick em `on-accent`) e a linha ganha `fill-selected`. Um card somente leitura (já respondido)
mantém o texto com força total, porque a escolha é o registro.

- **Acessibilidade.** O botão leva `aria-pressed`. O card coloca as opções num `fieldset`
  nomeado pela pergunta (`aria-labelledby`), para que um botão pressionado seja lido como uma
  resposta entre as irmãs.

## Status

### `Badge`

Uma pílula de 20px, 12px/500, em sentence case, nunca em maiúsculas. Pílulas são reservadas para
status: nada clicável é redondo. Ela leva uma palavra ou um ícone, então a cor nunca é o único
sinal.

| `variant` | Preenchimento    | Texto       |
| --------- | ---------------- | ----------- |
| `neutral` | `fill-selected`  | `fg-muted`  |
| `accent`  | `accent-subtle`  | `accent-fg` |
| `success` | `success-subtle` | `success`   |
| `warning` | `warning-subtle` | `warning`   |
| `error`   | `danger-subtle`  | `danger`    |
| `info`    | `info-subtle`    | `info`      |

Um badge que declara um estado vivo (a última conexão conhecida de um servidor MCP) pode começar
com um `StatusDot`, para não ser confundido com os badges neutros de metadado ao lado dele
(transporte, ambiente).

### `StatusDot`

Um ponto de 8px. `tone`: `accent`, `success`, `warning`, `error`, `neutral` (`stroke-strong`).
`pulse` é para um estado que está chegando a algum lugar (conectando, sondando), não para um que
já chegou. O dot de identidade de um runner é um `StatusDot` cuja cor vem de
`lib/agent-identity` via `className` (`MANGO_IDENTITY.dotClass`,
`agentIdentityTokens(targetId).dotClass`).

- **Acessibilidade.** Ele é `aria-hidden`. Nunca o use sozinho: ele acompanha texto visível,
  texto `sr-only`, ou fica dentro de um controle que tem `aria-label`.

### `Chip`

O par `key: value` fora do composer (`.terminal-chip`): mono 12px, 24px de altura,
`rounded-sm`, um hairline `stroke`, sem preenchimento. A chave (`label`) é `fg-muted`, o valor
`fg`. Um chip estático é informação. Com `onClick` ele vira um botão com hover `fill-hover`, e
disabled esmaece para 50%.

O composer não usa `Chip`: a faixa dele desenha o `.composer-chip` sem borda (veja a seção do
composer), e `ChipSelect` e `LockedChip` usam essa classe.

### `LockedChip`

O chip do composer para um fato em vez de uma escolha: o que um `ChipSelect` vira quando a
resposta dele está decidida (o agente e o ambiente depois do primeiro turno de um chat, o
ambiente quando só existe um). Chave em `fg-muted`, valor em `fg`, sem chevron, e o `reason`
como `title` e como texto `sr-only`, porque um tooltip não é anunciado e não existe no toque.
Ele não é desenhado a 50% como um controle desabilitado, porque o texto é informação
([decisão 18](./decisions.md)). O wrapper dele espelha o do `ChipSelect`, para que o `·` da
faixa fique no mesmo lugar ao lado dele.

### `KbdHint` E `MicroLabel`

`KbdHint` é uma tecla de 20px (`rounded-xs`, preenchimento `control`, borda `stroke`, mono 11px
em `fg-muted`) para um atalho, alinhada à direita onde a ação mora.

- A tecla Return é desenhada como ícone (`<KbdHint keys={<ReturnKey />} />`), não como o glifo
  de texto `⏎`, que fica fino como um fio a 11px e deixava a tecla parecendo vazia. O footer da
  paleta desenha as outras teclas do mesmo jeito (`ArrowUpDown`, `ArrowRightToLine` em
  `ICON_SM`).
- Nenhuma tecla é desenhada num ponteiro grosso: uma tela de toque não tem Esc nem Ctrl+N.
  `KbdHint` carrega `pointer-coarse:hidden` por conta própria, então os pontos de uso não o
  adicionam, e um `sm:inline-flex` do chamador não consegue trazê-lo de volta. O footer da
  paleta some junto.
- **Acessibilidade.** As teclas são `aria-hidden`, então o hint nunca renomeia o botão em que
  está ("Send", não "Send ⏎").

`MicroLabel` é o título de grupo (`.micro-label`): mono 11px, peso 500, em maiúsculas, tracking
de `0.06em`, `fg-subtle`. É o único lugar onde o texto fica em maiúsculas. Passe `as="h2"` ou
`as="h3"` quando ele encabeçar uma seção.

### `Callout`

Um aviso inline: uma faixa `rounded-md` no preenchimento do tom, um glifo de status em
`ICON_MD`, um título em `fg` a 500 e um corpo em `fg-muted`. O tom mora no preenchimento e no
glifo, nunca numa borda colorida nem nas palavras.

| `tone`             | Preenchimento    | Glifo                        |
| ------------------ | ---------------- | ---------------------------- |
| `neutral` (padrão) | `fill-selected`  | `Info` em `fg-muted`         |
| `info`             | `info-subtle`    | `Info` em `info`             |
| `success`          | `success-subtle` | `CircleCheck` em `success`   |
| `warning`          | `warning-subtle` | `TriangleAlert` em `warning` |
| `danger`           | `danger-subtle`  | `CircleX` em `danger`        |

- **`action`** é um controle `sm` (28px, 44px no toque) que fica no nível da primeira linha de
  texto, para que um aviso de uma linha com botão não seja mais alto que um sem. Numa coluna
  estreita (o rail do workspace, que pode ter só 280px) coloque a ação abaixo do corpo, senão o
  texto é espremido até virar uma tira.
- **`icon`** substitui o glifo do tom; `null` não desenha nenhum.
- **Acessibilidade.** O glifo é `aria-hidden`. Passe `role="status"` ou `role="alert"` quando o
  aviso aparecer em resposta a algo que a pessoa acabou de fazer.

Use um `Callout` para um aviso que a pessoa precisa ler ou sobre o qual precisa agir. Para um
resultado de uma linha ao lado da coisa que ele relata, use `StatusNote`.

### `StatusNote`

Um resultado de uma linha dentro de uma linha ou de um card (`components/settings/`): um glifo
`ICON_SM` na cor do status e as palavras em 12px `fg-muted`. `tone`: `success`
(`CircleCheck`), `warning` (`TriangleAlert`), `danger` (`CircleX`), `info` (`Info`).
`as="span"` para um pai que só aceita phrasing content, como um `<label>`. Use-o para o
resultado de um teste, uma entrada pulada, uma leitura que falhou: o tipo discreto de status que
não pede ação.

### `Spinner` E `Skeleton`

`Spinner` é um anel de 2px: um trilho `stroke-strong` com um arco `accent`. `size`: `sm` (16px)
dentro de botões e linhas, `md` (24px, o padrão) inline, `lg` (40px) para uma página esperando
dados.

- **`label`** nomeia a espera. Com ele, o spinner é `role="status"` com o label como texto
  `sr-only`: passe-o sempre que o spinner estiver sozinho. Sem ele, o spinner é `aria-hidden`:
  omita-o onde já há palavras ao lado ("Saving…"), senão a espera é anunciada duas vezes.

`Skeleton` (`.skeleton-block`) é um bloco `fill-selected` que pulsa a opacidade, sem gradiente de
shimmer. Forma e tamanho vêm do `className`. Ele é `aria-hidden`, então a região que mostra
skeletons também leva a palavra para um leitor de tela (como faz o `SettingsLoading`). As duas
animações param sob `prefers-reduced-motion`.

### `EmptyState`

Um bloco centralizado para uma lista vazia, uma árvore limpa ou uma busca sem resultados: um
ícone, um título a 14px/500 em `fg`, um `hint` a 12px em `fg-muted` (com no máximo 320px de
largura) e uma `action` opcional. Sem ilustrações e sem disco colorido atrás do ícone.

- **`icon`** é um glifo Lucide em `ICON_LG` (20px). O teste de conformidade rejeita um ícone de
  `EmptyState` cujo `size` seja um número literal.
- **`tone`** colore só o ícone: `neutral` (padrão) é `fg-subtle`, um degrau mais discreto que o
  título, porque o glifo é decoração e as palavras são a mensagem; `success`, `warning` e
  `error` carregam o significado na cor.
- **`action`** é um botão `secondary` `sm`, com um glifo `ICON_SM` à esquerda (`Plus` para uma
  ação que adiciona algo). Enquanto o empty state aparece, a página não desenha um botão no
  header que faça a mesma coisa ([`patterns.md`](./patterns.md)).

### `ToolAvatar`

O chip que representa uma tool: a imagem dela, ou um monograma de até dois caracteres sobre uma
cor derivada do seu `subjectKey` (`<kind>:<id>`), para que renomear uma tool não mude a cor
dela. A paleta em `ui/tool-avatar-palette.ts` dá a cada slot um fundo e um primeiro plano
declarados por tema, então o contraste do monograma é testado, não esperado. Uma falha ao
carregar a imagem cai de volta no monograma.

| `size`        | Caixa | Raio         | Uso                                                       |
| ------------- | ----- | ------------ | --------------------------------------------------------- |
| `2xs`         | 16px  | `rounded-xs` | Inline numa linha da timeline do chat.                    |
| `xs`          | 20px  | `rounded-xs` | Listas densas (o inspetor de capabilities).               |
| `sm`          | 24px  | `rounded-sm` | Linhas compactas: um servidor MCP, uma tabela de versões. |
| `md` (padrão) | 36px  | `rounded-md` | O header de identidade de uma tool.                       |
| `lg`          | 48px  | `rounded-lg` | O preview do editor de identidade.                        |

`TOOL_AVATAR_SIZE_CLASS` exporta as mesmas classes de caixa para um chip desenhado ao lado de um
avatar.

- **Acessibilidade.** O avatar é `aria-hidden`, com o `name` da tool como `title`: toda
  superfície imprime o nome ao lado dele, então anunciá-lo diria o nome duas vezes.

## Navegação

### `TabNav`

Abas sublinhadas para subpáginas irmãs, uma URL que pode virar favorito por aba. As abas têm
36px, `fg-muted` em repouso com hover `fill-hover`, e `fg` a 500 quando atuais, com um sublinhado
`accent` de 2px apoiado no divisor. Sem fundo tingido e sem cantos de pasta.

- Cada aba é dimensionada para o seu peso 500 (`TabLabel`), para que a faixa não se desloque nem
  um pixel quando a aba atual muda.
- A faixa é uma linha que rola para o lado quando as abas não cabem. Ela nunca quebra linha, o
  que deixaria o sublinhado ilhado numa linha sem divisor, e rola a aba atual para dentro da
  vista.
- **`exact`** acende uma aba só na própria URL: a raiz de uma superfície cujo caminho é prefixo
  das irmãs ficaria acesa em todas elas.
- **`current`** acende uma aba sob cuja URL a página não mora: a página própria de um recurso
  acende a aba do tipo dele.
- Faixas podem se aninhar: uma seção com um segundo nível renderiza sua própria faixa abaixo da
  faixa do pai.
- **Acessibilidade.** A faixa é um `<nav>` nomeado por `label`. A aba atual leva
  `aria-current="page"`, inclusive uma forçada por `current`. O anel de foco é desenhado dentro
  da aba, para que a lista com scroll não consiga cortá-lo.

### `Tabs`

A mesma aparência do `TabNav` para views guardadas em estado em vez de na URL: Changes e History
do painel git, as sessões do terminal, as seções de um repositório. `TAB_CLASSES` guarda a
aparência uma vez para os dois, para que nenhum dos dois se desvie.

- `active` pode ser `null` (uma faixa de sessões antes de alguma abrir). `trailing` fica depois
  da tablist (o botão que adiciona uma aba).
- Uma aba pode levar `actions` (fechar, renomear) depois do label; a aba é um `group` do
  Tailwind, então uma ação pode se revelar com `group-hover:`. `editor` substitui o label
  durante a renomeação no lugar, e as setas pulam essa aba. `title` é um tooltip para um label
  truncado.
- **Acessibilidade.** `role="tablist"` nomeado por `label`, `role="tab"` com `aria-selected`. A
  faixa é uma parada de Tab (a aba selecionada); setas, Home e End movem entre as abas e
  selecionam pelo caminho, dando a volta nas pontas.

### `NavItem` E A Sidebar

`NavItem` (`features/sidebar/components/NavItem.tsx`) é uma entrada de página. No rail do
desktop ele é uma linha de 32px `rounded-sm`: um ícone de 16px num slot centralizado de 20px, um
label truncado de 14px e, quando `badgeLabel` está definido, uma contagem de warning no fim (uma
pílula `warning-subtle`, mono 11px). Na grade de atalhos do celular
(`orientation="vertical"`) ele é um ícone de 20px sobre um label de 12px, sem contagem. A página
atual é `fill-selected` + `fg` a 500 e, no rail, também a barra `accent` de 3px
(`SELECTION_BAR`) na borda de entrada; ela leva `aria-current="page"`.

A sidebar é `sidebar`, com 256px por padrão e redimensionável de 240px a 420px, com uma linha de
marca de 48px que compartilha a baseline do header. "New chat" é um botão `primary` de largura
total com o atalho como `KbdHint`. Linhas de chat e entradas de página compartilham um recuo
(`px-3`) e um slot de ícone, para que a pílula e a barra accent de uma página selecionada fiquem
nas mesmas bordas das de um chat selecionado, e o label de uma página comece no mesmo x que o
título de um chat. Uma linha de chat adiciona um glifo git e o dot de identidade do runner em
mono 11px `fg-subtle`. A partir de 320px de largura, o nome da branch e suas contagens
ahead/behind se juntam ao glifo, e o nome do runner se junta ao dot. Esse metadado cede lugar aos
botões de renomear e excluir (`icon-sm`; `subtle` e `subtle-danger`) no hover e no foco por
teclado. Num ponteiro grosso, que não tem hover, só a linha do chat aberto os mostra, para que
as outras linhas mantenham a largura para o título. Abaixo de 320px o dot fica sozinho, porque
cada caractere que o metadado mantém é um que o título perde (o nome continua no documento,
então a busca e os leitores de tela ainda o leem). Home e Gallery não compartilham família de
glifo: uma casa e uma grade, não dois quadrados quase idênticos.

### `EdgeResizeHandle`

A borda de arraste de um painel redimensionável (`components/layout/EdgeResizeHandle.tsx`),
compartilhada pela sidebar e pelo rail do workspace. Uma área de toque de 8px atravessa a borda
do painel o tempo todo. A marca visível, uma pílula `rounded-xs` de 4×48px, só é desenhada no
hover (`stroke-strong`) e no foco por teclado (`focus`): em repouso, uma pílula em toda borda
era lida como um thumb de scrollbar perdido.

- **Teclado.** As setas movem a borda 16px, Home e End saltam para o mínimo e o máximo. A
  largura é salva uma vez só, no pointer-up, no key-up ou no blur, para que uma tecla segurada
  seja uma única escrita de settings.
- **Acessibilidade.** Um `<hr>` focável com `aria-orientation="vertical"`, nomeado por `label`,
  com `aria-valuemin`, `aria-valuemax` e `aria-valuenow`.

### `Header`

48px, `canvas`, uma borda inferior `stroke` (`components/layout/Header.tsx`). Todo botão é
`subtle`; não há ação primária no header.

- **Esquerda:** abaixo de `md`, o botão de menu que abre a sidebar como slide-over. Depois o
  seletor de runner, nas páginas onde um chat começa ou roda (Home e um chat) e em nenhum outro
  lugar; o chip de ambiente a partir de `sm`; o contexto do workspace a partir de `md`.
- **Direita:** a pílula de cota de um runner externo, quando houver. A partir de `md`, a paleta
  de comandos (um glifo de busca e seu `KbdHint`) e o bloco da conta (o nome, depois Sign out),
  ambos no tamanho padrão `md`, para que o grupo se leia num único tamanho de 14px. A partir de
  `md` o header não repete o que a sidebar já mostra.
- **Abaixo de `md`** o header mantém "New chat" (só o glifo abaixo de `sm`, nomeado por
  `aria-label` e `title`) e junta a paleta, Settings e Sign out num único `Menu` de conta atrás
  de um só glifo `UserRound`, para que o nome do runner fique com a linha.

### Seletor De Runner

O trigger de runner do header (`components/layout/RunnerSelector.tsx`) é um botão `subtle`: um
`StatusDot`, o nome do runner e um chevron, com `fill-selected` enquanto aberto.

- **O dot é identidade.** É a cor do runner (`agent-mango`, ou `agent-<target>` via
  `lib/agent-identity`), o mesmo dot que a sidebar, a paleta e a Home desenham. Nunca é
  disponibilidade e nunca é o accent.
- **Disponibilidade é um glifo depois do nome**, em `ICON_SM`, desenhado só quando o runner não
  pode assumir um turno, ou quando isso ainda não se sabe: `Info` em `fg-muted` para um runner
  ausente aqui, `TriangleAlert` em `warning` para um que tem conserto ou cujo sign-in ou
  descoberta é desconhecido, `CircleX` em `danger` para uma falha, `Spinner size="sm"` enquanto
  a descoberta carrega. Um runner pronto não mostra glifo, então um header saudável não carrega
  nenhuma cor de status.
- **Acessibilidade.** O `aria-label` do trigger nomeia o controle ("Who runs this chat"); a
  frase de disponibilidade é o `aria-describedby` dele e o `title` do glifo.

As linhas do seletor aberto levam os mesmos dots de identidade, mantidos com força total numa
linha desabilitada, cujo nome desce para `fg-muted` ([decisões 17 e 21](./decisions.md)).

### `Menu`

`Menu`, `MenuItem` e `MenuSeparator` renderizam um `.dropdown-panel` (`surface-raised` sólido,
borda `stroke`, `rounded-md`, `shadow-popover`, padding de 4px) abaixo do trigger, alinhado à
`right` por padrão (`align="left"` para inverter), `w-56` a menos que `panelClassName` diga
outra coisa.

- Os itens têm 32px, `rounded-sm`, 14px, com um ícone de 16px em `fg-muted`. O hover usa
  `fill-hover`; o foco por teclado desenha o outline de foco compartilhado. Um item desabilitado
  esmaece para 50%.
- `checked` transforma um item num toggle com um check em `accent-fg`.
- Um item destrutivo (`tone="danger"`) vai por último, depois de um separador, com texto
  `danger` e hover `danger-subtle`; o ícone dele continua `fg-muted`.
- **Acessibilidade.** `trigger` é uma render prop: espalhe as props que ela recebe
  (`aria-haspopup="menu"`, `aria-expanded`, `onClick`) no trigger. Os itens são
  `role="menuitem"`, ou `menuitemcheckbox` com `aria-checked` quando `checked` está definido. As
  setas movem entre os itens; Escape fecha o menu (e só o menu, dentro de um diálogo) e devolve o
  foco ao trigger.

## Contêineres

### `Card` E `SectionCard`

`Card` é uma `surface` flat com borda `stroke` e `rounded-md`, com padding `p-4` e `sm:p-6`.
Para qualquer outro padding, passe `padded={false}` e coloque o padding no `className`
(`<Card padded={false} className="p-4">`): um override `p-4` solto ainda seria `p-6` a partir de
`sm`. Um card que contém uma lista de linhas é `padded={false}` com `divide-y divide-stroke`, e
as linhas levam o próprio `px-4 py-3`. `Card` não repassa atributos `data-*`; coloque um test
id num wrapper.

`SectionCard` é um card com padding `p-4`, encabeçado por um `MicroLabel` (um `h3`) com um
`StatusDot` opcional (`tone`) e uma `action` à direita. Use-o para alguns fatos agrupados sob um
título, como faz o hub do workspace. Dentro de uma grade escalonada ele ganha a animação de
entrada da grade; em outros lugares ele monta sem animação.

Nunca aninhe um card dentro de um card; dentro de um, divida com uma linha `stroke`.

### `Dialog`

A moldura modal que todo diálogo compartilha (`ui/Dialog.tsx`): um backdrop `scrim` flat e um
painel `surface-raised` com borda `stroke`, `rounded-lg` e `shadow-dialog`
(`DIALOG_SURFACE_CLASS`, que a paleta de comandos também usa). Dentro: um header com padding de
24px e um título `text-title` (20px/600) alinhado à esquerda, um corpo que rola quando o diálogo
fica maior que a viewport, e um footer em `canvas` acima de uma linha `stroke`, com as ações
alinhadas à direita na largura natural, a discreta primeiro e a primária por último.

| `size`        | Largura     | Uso                                                     |
| ------------- | ----------- | ------------------------------------------------------- |
| `sm`          | `max-w-sm`  | Uma pergunta: uma frase e dois botões.                  |
| `md` (padrão) | `max-w-lg`  | Um formulário ou uma lista curta.                       |
| `lg`          | `max-w-3xl` | Uma lista de passos, uma tabela de comandos, um wizard. |

- **Nome.** Ou `title` (o título visível, que também é o nome acessível) ou `ariaLabel` para um
  diálogo sem título visível. Os tipos permitem um ou outro, nunca nenhum.
- **Slots.** `description` é uma frase discreta abaixo do título. `eyebrow` é uma linha acima do
  título, `leading` um elemento antes dele (um avatar), `headerAction` um controle na linha do
  título (Close, para um diálogo sem Cancel). `toolbar` fica fixo entre header e corpo (um campo
  de busca, uma barra de passos). `notice` é um `Callout` entre corpo e footer, para que uma
  falha fique à vista. `truncateTitle` mantém numa linha só um título que contém o texto da
  própria pessoa.
- **`flush`** entrega o corpo a um layout com seus próprios painéis e regiões de scroll: sem
  padding, sem scroll, e um hairline abaixo do header.
- **`onSubmit`** envolve o diálogo num `<form>`, para que o botão de submit do footer o envie.
- **`closeDisabled`** faz Escape e o backdrop não fazerem nada, como faz um Cancel desabilitado,
  enquanto uma escrita está em andamento.
- **Acessibilidade.** `role="dialog"`, `aria-modal`, nomeado pelo título e descrito pela
  `description`. O foco entra (a menos que um controle de dentro o pegue com `autoFocus`), o Tab
  fica dentro, Escape e um clique no backdrop chamam `onClose`, e o foco volta para o que o
  abriu. Um arraste que começa no painel e termina no backdrop não o fecha. O diálogo monta em
  `document.body`, para que um ancestral com transform não consiga encurtar o scrim.

### `ConfirmDialog`

Um `Dialog` com `size="sm"` para uma confirmação destrutiva. Um título em forma de pergunta, uma
`description` que nomeia a consequência, o `entityName` citado abaixo dela em `fg` a 500 quando o
título ainda não o nomeia, e um footer com um Cancel `secondary` e depois um botão `danger` com o
verbo. Sem disco de ícone gigante. `children` adiciona controles (um checkbox) entre o texto e os
botões.

- **Acessibilidade.** O foco cai no Cancel, a resposta segura. Enquanto `isPending`, o botão de
  confirmar mostra o spinner, Cancel fica desabilitado, e Escape e o backdrop esperam.

### `Toast`

`ToastProvider` desenha a pilha; `useToast().toast(message, type)` adiciona um, com `type`
`success`, `error` ou `info` (o padrão).

- **Posição.** No canto superior direito, 16px abaixo do header (`top-16 right-4`), para nunca
  cobrir a ação primária de uma região: o canto inferior é onde fica o Send do composer
  ([decisão 25](./decisions.md)).
- **Cara.** 360px de largura (nunca mais largo que a tela), `surface-raised`, borda `stroke`,
  `rounded-md`, `shadow-popover`. O tipo aparece só no glifo `ICON_LG` (`CircleCheck` em
  `success`, `CircleX` em `danger`, `Info` em `info`); a mensagem fica em `fg`. Um botão de
  ícone `subtle` o dispensa.
- **Tempo.** Ele some depois de 4s. O relógio para enquanto o ponteiro está sobre o toast ou o
  foco está dentro dele, e retoma com o tempo que faltava.
- **Acessibilidade.** A pilha é uma `region` nomeada "Notifications" e uma live region polite;
  um toast de erro também é `role="alert"`, então um toast é anunciado além de visto.
- Um erro que pede ação pertence a um `Callout`, não a um toast.

## Settings

Os blocos de construção de toda página de settings moram em `components/settings/`. Uma página é
um `SettingsPage` com `SettingsSection`s, que contêm `SettingsRow`s.

### `SettingsPage`

A moldura de uma página de settings: um título `text-title`, uma `description` opcional em
`fg-muted`, e depois as seções da página em `space-y-8`. O indicador de auto-save e as `actions`
(Add, Refresh, uma legenda de "last updated") ficam alinhados à direita e centralizados na linha
do título; numa tela estreita eles quebram para baixo da descrição. Nenhuma página desenha o
próprio card de título nem coloca um tile de ícone ao lado do título.

### `SettingsNav`

A navegação de settings: toda página de settings sob o título do seu grupo (`MicroLabel` como
`h2`), numa única lista no DOM. A partir de `lg` ela é uma coluna sticky no canvas ao lado do
conteúdo; abaixo de `lg` ela se recolhe atrás de um toggle com cara de campo (`FIELD_CLASS`) que
nomeia a página atual, e fecha a cada navegação. A entrada atual é `fill-selected`, `fg` a 500 e
a `SELECTION_BAR`. A lista de rotas mora uma vez só em `settings-nav.ts`, que a paleta de
comandos também lê.

### `SettingsSection`

Um grupo titulado de settings num único `Card` flat: um `title` de 16px/600, uma `description`
opcional em `fg-muted`, e uma `action` (Add, Refresh) centralizada na linha do título. Omita
`title` para o primeiro card sem título abaixo do título da página.

- Por padrão os filhos são `SettingsRow`s divididas por linhas `stroke`.
- **`padded`** dá a um conteúdo livre (um preview, uma grade de tiles) um corpo `p-4`.
- **`cards`** dá a cada filho seu próprio card, empilhados em `space-y-3`, para unidades de
  várias linhas, como um arquivo de regras: uma borda de card, e não mais um hairline, as separa.
- **`notice`** é um `Callout` entre o título e o card.

### `SettingsRow`, `SettingToggle` E `SettingsSliderRow`

`SettingsRow` é uma configuração: o seu `label` (14px/500) e `hint` (12px `fg-muted`), e o seu
controle. A linha é dona do próprio padding `px-4 py-3`; os hairlines entre as linhas vêm do card
da seção.

| `layout`          | Onde o controle fica                                                                                         | Para                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `inline` (padrão) | À direita do nome, na própria largura, em todo breakpoint.                                                   | Um switch, um checkbox, um botão pequeno ou um campo numérico. |
| `field`           | À direita do nome, com 16rem de largura, a partir de `sm`; abaixo do nome, em largura total, abaixo de `sm`. | Um `Select` ou um campo de texto.                              |
| `stacked`         | Abaixo do nome, em largura total.                                                                            | Um slider, um textarea, um controle segmentado, um caminho.    |

- `htmlFor` torna o nome um `<label>` do controle; `as="label"` torna a linha inteira o label,
  para que um clique em qualquer ponto dela alterne um switch ou checkbox sozinho.
- `aside` é conteúdo no fim da linha do nome: uma leitura ao vivo (`30s`) ou uma ação pequena
  (Reset).

`SettingToggle` é um `SettingsRow` (`as="label"`) cujo controle é um `ToggleSwitch`. Settings
salvam conforme mudam, então o controle de liga/desliga delas é um switch, não um checkbox.

`SettingsSliderRow` é uma linha `stacked` cujo controle é um slider de intervalo: uma pílula
`.range-field` com preenchimento `accent` sobre a parte percorrida, em volta de um thumb
`.range-input`. `readout` é o valor em palavras na linha do nome, tabular para que os dígitos não
tremam. `withNumberInput` adiciona um campo numérico `w-32` para entrada exata, que faz clamp no
blur. Um intervalo com centenas de passos é um campo numérico simples numa linha `inline`, porque
ninguém consegue ajustá-lo arrastando.

### `SettingsField`

Um campo num editor de registro: o seu `label` acima (14px/500, um `<label htmlFor>` quando
`htmlFor` está definido), o controle, e um `hint` abaixo (12px `fg-muted`). Use-o para um
controle que não desenha o próprio label (`Select`, `Textarea`, uma lista de linhas) e para um
`Input` que precisa de hint, para que todo campo de um editor se alinhe do mesmo jeito.

### `SettingsLoading`, `SettingsLoadError` E `SettingsSaveIndicator`

`SettingsLoading` são blocos skeleton no formato do conteúdo, `shape="row"` (32px) ou `"card"`
(96px), `count` deles, dentro de um `role="status"` que também diz "Loading" a um leitor de
tela. Sem spinner por cima: ele diria a mesma coisa duas vezes.

`SettingsLoadError` é o estado de falha no carregamento: um `Callout` `danger` com a `message`
e, quando `onRetry` é passado, um Retry `secondary` `sm`. Ele fica na tela até o carregamento
funcionar; um toast não é um estado de erro.

`SettingsSaveIndicator` fica no header do `SettingsPage` e informa o auto-save, já que não há
botão Save: um `Spinner` e "Saving…" em `fg-muted`, um check `success` e "Saved" em `fg-muted`,
ou um `CircleX` e "Not saved", os dois em `danger`. Ele tem 12px, fica num `role="status"`
polite e não desenha nada enquanto ocioso. O glifo carrega o estado e a palavra o repete.

`RuleFileRows` (um arquivo de regras de prompt como linhas de uma seção `cards`) e
`ThemePreviewSample` (uma amostra de código desenhada nas cores literais do próprio tema Shiki,
que não podem seguir os tokens do app) são partes de página, não primitivos.

## Marca

### `Logo` E `BrandLockup`

`Logo` é a marca do produto como imagem; o `alt` dele tem como padrão "MangoStudio logo"
(`t.common.mangoStudioLogo`). Dimensione-o com `className`.

`BrandLockup` (`components/layout/BrandLockup.tsx`) é o nome do produto acima das páginas que não
têm shell: sign-in, sign-up e onboarding. O `Logo` em 48px (`size-12`) sobre "MangoStudio" a
14px/500 em `fg-muted`, com 8px entre os dois. É um wordmark, não um título (o título próprio de
cada página é o seu `h1`), e a marca dentro dele tem `alt` vazio, porque a palavra ao lado já
nomeia o produto. Not Found mantém o logo dentro do card dele; o erro de bootstrap não tem logo
e abre com um `CircleX` `danger`.

## Os Componentes Próprios Do Chat

### Composer (`InputBar`)

`surface`, borda `stroke`, `rounded-lg` (`.composer-shell`), e a única superfície que veste a
identidade do runner. `--composer-accent` (vindo do runner do chat, via
`features/chat/lib/composer-accent.ts`) colore a borda enquanto focado, a marca de prompt `❯`, o
cursor de texto e o próprio chip do runner. Send é **sempre** o `accent` do produto: uma ação
primária, uma cor, seja quem for que estiver respondendo.

Uma linha de status no topo leva chips mono `key: value` (`.composer-chip`: 24px, sem borda,
chave `fg-muted`, valor `fg`), fechada por uma linha `stroke`. A partir de `sm` os chips são
separados por um `·` que a própria faixa (`.composer-chip-row`) desenha. Todo filho da faixa é
um slot sem gap em volta de um chip, nunca o chip em si e nunca uma faixa aninhada; um componente
com vários chips devolve um fragmento de slots. O ponto tem uma caixa fixa de 8px e um recuo de
4px contra o gap de 4px da faixa, então toda sequência chip, ponto, chip tem 16px com o ponto
centralizado. Um teste unitário garante o contrato do slot.

A linha de tools abaixo usa os mesmos chips sem borda (`.composer-tool-chip`: 28px, um glifo à
esquerda, em minúsculas), com o hairline `stroke` voltando só abaixo de `sm`, onde o label some e
um quadrado nu de 44px numa tela sem hover precisa de algo que diga que ele é um botão. Um chip
de toggle é `aria-pressed`: ligado, ele ganha `fill-selected` (o mesmo tom do menu aberto) e
tinge o ícone da esquerda com `--composer-accent`, para que ligado e aberto nunca pareçam
iguais; `create images`, que não tem chip de valor ao lado, também mostra um check a partir de
`sm`. Abaixo de `sm` os chips de tool são só ícone e o glifo fica centralizado no quadrado. Todo
chip que faz algo mostra o cursor de ponteiro e um estático não, e é isso que distingue um toggle
sem valor ao lado (`thinking`) de um fato. Os preenchimentos de hover dos chips só se aplicam num
ponteiro que consegue fazer hover.

### `ComposerPopover`

A superfície que todo menu sobre o composer usa (os menus de modelo, de permissão, de MCP e de
slash commands, o inspetor de capabilities, e todo `ChipSelect` que abre para cima): um
`.dropdown-panel`, `w-80` por padrão, ancorado 8px acima do shell do composer, seja qual for o
chip que o abriu. A borda esquerda dele fica alinhada ao controle `anchor`, limitada para nunca
passar da borda do composer. O ancestral posicionado do painel é `.composer-shell`, então o
wrapper em volta do trigger não pode ser `relative`. `animated` faz o painel surgir com fade e
subida, como todo menu de chip faz; uma paleta que acompanha a digitação fica parada. Padding,
overflow e espaçamento ficam com o ponto de uso (`p-1` para uma lista, `p-3` para um
formulário).

### Anel De Contexto (`ContextRing` E `ContextUsageChip`)

O anel de contexto é um glifo de 16px com o número ao lado (`62%`, mono, 12px, `fg-muted`) na
faixa do composer (`showValue={false}`), e um anel de 20px com o número dentro numa linha da
sidebar, onde um título está sendo truncado ao lado. Esse número interno tem 8px, peso 600, em
`fg`: um glifo que faz parte do desenho, abaixo da escala tipográfica de propósito
([decisão 26](./decisions.md)). O arco de 2.5px é `fg` enquanto o uso é `normal` ou `info`, e
passa para `warning`, depois `danger` (`danger` e `critical`) conforme o tracker escala. Manga
não é usada, porque 62% saudáveis não são a ação primária, nem o item atual, nem o foco. O
trilho por baixo é o hairline `stroke`: o trilho de um medidor é estrutura, e um arco desenhado
sobre `fg-subtle` se fundia com ele a 16px, fazendo 62% parecer um anel completo.

`ContextUsageChip` é o anel e a porcentagem da faixa como um botão `.composer-chip` sem clique
próprio: os números por trás dele (contagens de tokens, a janela, cada escopo reportado) abrem
num `.dropdown-panel` acima dele, crescendo para a esquerda, no hover ou no foco por teclado. O
`aria-label` dele contém o detalhamento inteiro e o painel é `aria-hidden`, então um leitor de
tela o ouve uma vez só. Sem uma proporção para desenhar, ele mostra `fallback` no lugar do anel.

### Timeline E Blocos De Tool

O turno do assistente é um trilho de 1px `stroke-strong` com nós de 7px: `fg-subtle` em repouso,
`success` quando terminado, `danger` em erro, `stroke-strong` quando silenciado, e `accent-fg`
enquanto roda (pulsando), porque uma conta precisa passar de 3:1 contra o canvas sozinha. Uma
linha tem 24px, ou 44px num ponteiro grosso, para que o nó fique centralizado numa linha que o
piso de toque aumentou.

Uma chamada de tool é uma linha da timeline com o nome em mono. Expandida, ela abre num painel
`surface` com borda `stroke` e `rounded-md` (`TimelineDisclosure`). Dentro, cada seção
(argumentos, saída, o diff de arquivo de um Edit) tem um header de 32px com um `MicroLabel` ou o
caminho do arquivo, e depois o conteúdo como uma faixa `canvas` de ponta a ponta em mono. A
mensagem do usuário é um balão `surface` com borda `stroke` e `rounded-lg`. Os cards de um turno
(lista de tarefas, trace de subagente, pergunta, aprovação, aviso, erro) terminam onde termina o
balão de prosa: eles ficam um recuo para dentro do trilho, então são limitados a
`--timeline-card-max` (a medida de 42rem menos esse recuo) em vez da medida inteira. Linhas de
tool e saída de tool não são cards e ficam com a coluna inteira.

### `TurnMetaRow`

A linha que fecha um turno (`features/chat/components/TurnMetaRow.tsx`): quanto tempo levou e
como terminou. Uma anatomia para todo tipo de turno (um turno de texto do MangoStudio, um turno
de imagem, o turno de um agente externo): um recuo para dentro do trilho (`pl-4`), mono 11px em
`fg-subtle`, um glifo `ICON_SM` na mesma cor, com 6px entre eles. O glifo nomeia o desfecho:
`Sparkles` para concluído, `CircleX` para falhou, `CircleStop` para interrompido. Ele fica em
`fg-subtle` em vez de uma cor de status, porque as palavras carregam o desfecho e a linha precisa
ficar mais discreta que o turno acima dela.

### Markdown

Os títulos são Inter 600; código inline é mono sobre `fill-selected` com `rounded-xs`; blocos de
código são `surface` com borda `stroke` (o Shiki mantém o fundo do próprio tema); links são
`accent-fg`; a régua de um blockquote é `stroke-strong`, não um accent. Uma tabela fica num
wrapper `.markdown-table-scroll` que rola para o lado quando as colunas precisam de mais espaço
que o balão, e código inline numa célula nunca quebra num hífen. Um bloco de código com rótulo
tem uma linha de header de 2.5rem acima da primeira linha: o rótulo da linguagem fica à esquerda
(1rem para dentro) e o botão de copiar à direita (0.5rem para dentro), os dois numa caixa de 28px
com recuo superior de 0.5rem, para que compartilhem um centro vertical. O rótulo aparece sempre
e nunca esmaece, porque nunca cobre código. O botão de copiar (`.copy-code-btn`) aparece quando
o ponteiro está sobre o bloco ou quando ele tem o foco do teclado, e fica visível numa tela que não faz hover. Um trecho sem rótulo
mantém o padding simples de `1em`. O rótulo é posicionado em relação ao bloco, então ele rola
junto com o código quando um bloco largo rola para o lado. O wrapper da tabela desenha uma
scrollbar fina sempre visível, com trilho, para que uma tabela cortada na terceira coluna se leia
como rolável.

## Strings De Classe Compartilhadas

Algumas aparências são exportadas como strings de classe em vez de componentes, para um elemento
que precisa combinar com um componente sem ser um.

| Export                   | Arquivo                                        | O que é                                                                                 |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `buttonClassName()`      | `ui/Button.tsx`                                | As classes de um `Button` para um `<Link>` ou um `<a>`.                                 |
| `FIELD_CLASS`            | `ui/Input.tsx`                                 | A cara do campo de texto, para um campo inline ou um toggle com cara de campo.          |
| `DIALOG_SURFACE_CLASS`   | `ui/Dialog.tsx`                                | A superfície do painel flutuante, compartilhada por `Dialog` e pela paleta de comandos. |
| `TAB_CLASSES`            | `ui/Tabs.tsx`                                  | A aparência de aba sublinhada, compartilhada por `TabNav` e `Tabs`, com `TabLabel`.     |
| `SELECTION_BAR`          | `ui/selection-bar.ts`                          | A barra `accent` de 3px do item atual numa lista vertical. A linha é `relative`.        |
| `TOOL_AVATAR_SIZE_CLASS` | `ui/ToolAvatar.tsx`                            | A caixa do `ToolAvatar` por tamanho.                                                    |
| `MEDIA_CONTROL_CLASS`    | `features/gallery/components/media-control.ts` | A cara de um botão `subtle` sobre o véu `scrim-media`.                                  |
