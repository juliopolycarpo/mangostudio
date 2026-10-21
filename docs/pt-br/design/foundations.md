# Fundamentos

Os tokens por trás do design flat: cor, tipografia, espaçamento, raio, elevação, estado,
movimento e ícones. Todo valor vive em [`apps/frontend/src/index.css`](../../../apps/frontend/src/index.css):
`@theme static` guarda o tema escuro, que é o padrão, e `[data-theme="light"]` o
sobrescreve. Todo utilitário citado aqui é a classe que você escreve.
[`README.md`](./README.md) explica por que o sistema tem esta forma;
[`components.md`](./components.md) explica como as peças usam estes tokens.

## Cor

Os tokens têm o nome do **papel** que cumprem, nunca do valor que por acaso guardam. Um
port nativo associa cada papel ao recurso da plataforma que cumpre esse papel (veja
[`native-ports.md`](./native-ports.md)); um valor hexadecimal não teria essa associação.

O tema esvazia a paleta do próprio Tailwind (`--color-*: initial`), então `bg-amber-500`
ou `text-blue-400` não geram nada. `transparent` e `currentColor` continuam funcionando.

Regras que valem para todos eles:

- Texto, ícones e marcas que carregam significado passam do piso de contraste nos
  **dois** temas: 4.5:1 para texto, 3:1 para linhas de controle, anéis de foco e glifos.
- Uma tinta é um token (`*-subtle`, `fill-*`), nunca um modificador de opacidade. O teste
  de conformidade rejeita `bg-accent/10`, assim como uma cor arbitrária numa classe
  (`bg-[#…]`, `text-[rgb(…)]`, `border-[var(--color-…)]`, `bg-[color-mix(…)]`;
  [decisão 24](./decisions.md)), uma cor crua da paleta (`text-red-500`) e
  uma sobreposição crua de `black` ou `white` (`bg-black/50`). As folhas de estilo também
  não escrevem `color-mix()` ([decisão 13](./decisions.md)).
- Cores de status sempre vêm acompanhadas de um ícone ou de uma palavra. Cor sozinha não
  é sinal.
- O destaque (accent) é o único matiz da interface. As cores `agent-*` identificam
  runners e nada mais.

As tabelas abaixo são o contrato de cor: `tests/unit/design-tokens-doc.test.ts` falha se
um token falta aqui, está listado aqui mas sumiu de `index.css`, ou tem outro valor em
qualquer um dos temas. O teste lê a versão em inglês
([`docs/design/foundations.md`](../../design/foundations.md)); este espelho não é
verificado, então mantenha os valores iguais aos dela.

### Superfícies

| Token            | Utilitário          | Escuro    | Claro     | Uso                                                                                                                                         |
| ---------------- | ------------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas`         | `bg-canvas`         | `#151311` | `#f6f4f0` | A janela e a área de conteúdo principal (chat, settings). O cabeçalho a compartilha, então não há faixa mais escura.                        |
| `sidebar`        | `bg-sidebar`        | `#1b1916` | `#eeebe5` | A barra lateral. Um degrau acima de `canvas`, fechada por uma linha `stroke`.                                                               |
| `surface`        | `bg-surface`        | `#1f1d1a` | `#ffffff` | Cards, painéis de seção, o compositor, blocos de tool. Sempre com borda `stroke`, nunca com sombra.                                         |
| `surface-raised` | `bg-surface-raised` | `#282521` | `#ffffff` | O que flutua: menus, listboxes, popovers, diálogos, toasts, a paleta de comandos. Com `shadow-popover` ou `shadow-dialog` e borda `stroke`. |

### Controles e preenchimentos de interação

| Token             | Utilitário           | Escuro      | Claro       | Uso                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control`         | `bg-control`         | `#2f2c27`   | `#ffffff`   | Preenchimento de campos de texto, gatilhos de Select, botões secundários, segmentos não selecionados, caixas de checkbox e radio, trilhos do switch e do slider, keycaps, o botão de copiar do bloco de código. Um degrau acima de `surface-raised`, então um campo num diálogo continua sendo um campo ([decisão 19](./decisions.md)). |
| `control-hover`   | `bg-control-hover`   | `#37342e`   | `#f7f5f1`   | Os mesmos controles sob o ponteiro.                                                                                                                                                                                                                                                                                                     |
| `control-pressed` | `bg-control-pressed` | `#2a2723`   | `#f0ede7`   | Botão secundário enquanto pressionado. Um degrau mais escuro que `control` nos dois temas.                                                                                                                                                                                                                                              |
| `fill-hover`      | `bg-fill-hover`      | `#fff5e60f` | `#2a1e0a0d` | Hover de tudo que não tem preenchimento próprio: botões subtle, itens de menu, linhas da barra lateral, linhas de lista, abas inativas, chips. Também a faixa estática das linhas pares de uma tabela markdown, um degrau abaixo do cabeçalho em `fill-selected`.                                                                       |
| `fill-pressed`    | `bg-fill-pressed`    | `#fff5e608` | `#2a1e0a08` | Estado pressionado da família `fill-hover`. Uma camada mais fina que `fill-hover` nos dois temas.                                                                                                                                                                                                                                       |
| `fill-selected`   | `bg-fill-selected`   | `#fff5e614` | `#2a1e0a12` | O item atual na navegação e em listas, um chip aberto ou pressionado, código inline, o botão preenchido desabilitado, skeletons, o `Badge` e o `Callout` neutros. Neutro de propósito: a barra `accent` carrega a cor.                                                                                                                  |

### Linhas

| Token           | Utilitário             | Escuro    | Claro     | Uso                                                                                                                                                                                                                                      |
| --------------- | ---------------------- | --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stroke`        | `border-stroke`        | `#35312b` | `#e3ded5` | Linha fina decorativa: bordas de cards e superfícies, divisores, a borda da barra lateral, a borda inferior do cabeçalho. A cor padrão de um `border` puro.                                                                              |
| `stroke-strong` | `border-stroke-strong` | `#857f73` | `#8a8478` | A linha que identifica um controle: a borda inferior de um campo, caixas de checkbox e radio, trilhos do switch e do slider, o trilho da timeline, polegares de barra de rolagem. Pelo menos 3.1:1 em toda superfície e sobre `control`. |

### Texto

| Token       | Utilitário       | Escuro    | Claro     | Uso                                                                                                                                                                                                                                                                        |
| ----------- | ---------------- | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fg`        | `text-fg`        | `#ece7df` | `#1e1b16` | Texto principal e ícones ativos.                                                                                                                                                                                                                                           |
| `fg-muted`  | `text-fg-muted`  | `#b0a99e` | `#5a554c` | Texto secundário, descrições, a metade da chave de um chip, ícones em repouso, o botão `subtle-danger` em repouso. Pelo menos 5.9:1 em toda superfície e sobre `control`, 5.3:1 sobre `control-hover`; um degrau nítido acima de `fg-subtle`.                              |
| `fg-subtle` | `text-fg-subtle` | `#a29b91` | `#6b655b` | Placeholders, horários, metadados, dicas, `.micro-label`. Pelo menos 4.5:1 em toda superfície, sobre `control` e `control-hover`, e sobre toda lavagem `*-subtle` e `fill-*` sobre `canvas` e `surface`. É o piso do texto: nunca esmaeça texto com opacidade abaixo dele. |

### Destaque (manga)

| Token            | Utilitário          | Escuro      | Claro       | Uso                                                                                                                                                                                                           |
| ---------------- | ------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accent`         | `bg-accent`         | `#f5a623`   | `#f0a020`   | Preenchimento do botão principal, de um switch, checkbox ou radio marcado, do trecho percorrido e do polegar do slider, da barra do item atual, do cursor de streaming. Texto sobre ele é sempre `on-accent`. |
| `accent-hover`   | `bg-accent-hover`   | `#f7b44a`   | `#f2ad3c`   | Botão principal e caixas marcadas sob o ponteiro.                                                                                                                                                             |
| `accent-pressed` | `bg-accent-pressed` | `#e0961a`   | `#e09114`   | Botão principal enquanto pressionado; o divisor dentro de um botão dividido principal.                                                                                                                        |
| `on-accent`      | `text-on-accent`    | `#241600`   | `#241600`   | Texto e ícones sobre `accent` (8.2:1 ou mais). Escuro nos dois temas para que a manga continue laranja no modo claro.                                                                                         |
| `accent-fg`      | `text-accent-fg`    | `#f5a623`   | `#8f5a00`   | Manga como texto ou ícone sobre uma superfície: links, o check de um item de menu, dicas de soltar, a conta ativa da timeline. 4.8:1 ou mais.                                                                 |
| `accent-subtle`  | `bg-accent-subtle`  | `#f5a62324` | `#f5a62329` | Uma camada de manga para um estado ativo discreto: a dica de soltar, um badge de destaque, texto selecionado.                                                                                                 |
| `focus`          | `outline-focus`     | `#f5a623`   | `#8f5a00`   | O anel de foco do teclado: 2px, deslocado 2px, em todo controle. 4.8:1 ou mais em toda superfície.                                                                                                            |

### Status

| Token            | Utilitário          | Escuro      | Claro       | Uso                                                                                                     |
| ---------------- | ------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `success`        | `bg-success`        | `#4ade80`   | `#166534`   | Texto e ícone de sucesso. Sempre com um ícone ou uma palavra.                                           |
| `success-subtle` | `bg-success-subtle` | `#4ade801f` | `#15803d1a` | Preenchimento de um badge ou callout de sucesso.                                                        |
| `warning`        | `bg-warning`        | `#ffd166`   | `#92400e`   | Texto e ícone de atenção. Sempre com um ícone ou uma palavra.                                           |
| `warning-subtle` | `bg-warning-subtle` | `#ffd1661f` | `#ffbf0029` | Preenchimento de um badge ou callout de aviso. Âmbar nos dois temas.                                    |
| `danger`         | `bg-danger`         | `#f87171`   | `#c42b1c`   | Texto e ícone de erro, e o ponto de status de erro. Sempre com um ícone ou uma palavra.                 |
| `danger-subtle`  | `bg-danger-subtle`  | `#f871711f` | `#c42b1c14` | Preenchimento de um badge ou callout de erro; hover de um item de menu destrutivo e de `subtle-danger`. |
| `danger-solid`   | `bg-danger-solid`   | `#c42b1c`   | `#c42b1c`   | Preenchimento do botão destrutivo (excluir, revogar). Sempre com `on-danger`.                           |
| `on-danger`      | `text-on-danger`    | `#ffffff`   | `#ffffff`   | Texto sobre `danger-solid` (5.7:1).                                                                     |
| `info`           | `bg-info`           | `#7cb8ff`   | `#1f63c4`   | Texto e ícone de informação neutra e notas.                                                             |
| `info-subtle`    | `bg-info-subtle`    | `#7cb8ff1f` | `#1f63c414` | Preenchimento de um badge ou callout de informação.                                                     |

`success` e `warning` no tema claro são mais escuros do que uma página branca simples
exigiria, porque o texto nessas cores também é lido sobre a própria tinta em cima de
`canvas`, `sidebar` e `surface` (um badge, uma linha de diff, um callout). `#166534` e
`#92400e` mantêm 5:1 ou mais nesses casos; os mais claros `#15803d` / `#b45309` caíam para
cerca de 4:1 sobre a tinta. `tests/unit/design-token-contrast.test.ts` exige de cada cor de
status 4.5:1 sobre a própria tinta.

O `warning-subtle` claro é uma camada âmbar (`#ffbf00` a 16%), e não uma cópia rala da cor
de texto `warning`. A 10%, essa cópia saía com o mesmo rosado de `danger-subtle` sobre
`canvas`, então um aviso de login e uma falha só se distinguiam pelo glifo; o âmbar parece
amarelo ao lado da camada rosa de perigo e é mais claro, então `fg-subtle` (4.9:1) e
`accent-fg` (4.9:1) passam de 4.5:1 sobre ele em cima de `canvas`, e `warning` fica em
6.0:1 ([decisão 20](./decisions.md)).

### Sobreposição e identidade

| Token                | Utilitário              | Escuro      | Claro       | Uso                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrim`              | `bg-scrim`              | `#0000008c` | `#1e1b1652` | O véu atrás de um diálogo, da paleta de comandos ou da barra lateral no celular. Uma tinta chapada, nunca um desfoque.                                                                                                                                                            |
| `scrim-media`        | `bg-scrim-media`        | `#000000b3` | `#000000b3` | O véu sob texto posto sobre uma imagem: a barra de legenda de um item da galeria, o fundo do lightbox. Igual nos dois temas, porque uma fotografia não tem tema. 70% de preto, então `on-scrim-media` mantém 4.5:1 (8.6:1 sobre branco) seja qual for a imagem.                   |
| `on-scrim-media`     | `text-on-scrim-media`   | `#ffffff`   | `#ffffff`   | Texto, ícones e o anel de foco sobre `scrim-media`. Branco nos dois temas.                                                                                                                                                                                                        |
| `fill-media-hover`   | `bg-fill-media-hover`   | `#ffffff29` | `#ffffff29` | Preenchimento de hover de um controle posto sobre `scrim-media` (o Fechar do lightbox, o download de um item): `on-scrim-media` a 16%. Sem tema, como o véu. Aplicado por `MEDIA_CONTROL_CLASS` em `features/gallery/components/media-control.ts` ([decisão 23](./decisions.md)). |
| `fill-media-pressed` | `bg-fill-media-pressed` | `#ffffff3d` | `#ffffff3d` | Preenchimento pressionado de um controle sobre `scrim-media`: `on-scrim-media` a 24%.                                                                                                                                                                                             |
| `agent-mango`        | `bg-agent-mango`        | `#f5a623`   | `#955900`   | O runner do próprio MangoStudio: o ponto, a borda do compositor, a marca do prompt. O valor claro é escurecido para `#955900` porque também é lido como texto (veja abaixo).                                                                                                      |
| `agent-claude`       | `bg-agent-claude`       | `#e0836a`   | `#a64c34`   | Identidade do runner Claude Code.                                                                                                                                                                                                                                                 |
| `agent-codex`        | `bg-agent-codex`        | `#5cc8e8`   | `#1c6f8b`   | Identidade do runner Codex.                                                                                                                                                                                                                                                       |
| `agent-cursor`       | `bg-agent-cursor`       | `#a78bfa`   | `#6b4dd8`   | Identidade do runner Cursor.                                                                                                                                                                                                                                                      |
| `agent-generic`      | `bg-agent-generic`      | `#9a958a`   | `#6b665d`   | Um runner sem identidade própria.                                                                                                                                                                                                                                                 |

`lib/agent-identity.ts` associa cada runner ao seu token de duas formas: uma classe
`bg-agent-*` para o ponto (`dotClass`) e uma referência `var(--color-agent-*)`
(`colorVar`). A forma `var()` é lida em estilos inline (o destaque do compositor via
`features/chat/lib/composer-accent.ts`, o separador de turnos), que o Tailwind não
varre. Por isso o tema é `@theme static`: um `@theme` simples descartaria esses tokens do
padrão escuro. Os dois leem a cor como texto (a marca do prompt sobre `surface`, o
monograma do separador sobre `fill-selected` acima do chat), então todo valor `agent-*`
passa de 4.5:1 sobre `surface` e sobre `fill-selected` acima de `canvas` e `surface` nos
dois temas; os claros são mais escuros do que um ponto sozinho exigiria.

### Qual superfície, qual preenchimento

```text
canvas          a janela, o chat, uma página de settings
  sidebar       a barra lateral, um degrau acima de canvas
  surface       um card, o compositor, um bloco de tool   (+ borda stroke)
    control     um campo ou botão secundário dentro dele
  surface-raised  um menu, diálogo, toast, popover        (+ borda stroke + elevação)
```

Hover, pressão e seleção em qualquer coisa *sem* preenchimento próprio usam as camadas
neutras `fill-hover` / `fill-pressed` / `fill-selected`. Elas são translúcidas, então
funcionam igualmente sobre `canvas`, `sidebar` e `surface`. O hover nunca puxa para o
destaque: o destaque diz "principal" ou "atual", não "o ponteiro está aqui".

## Tipografia

Uma família de interface e uma mono, ambas hospedadas no próprio app como fontes
variáveis. As pilhas caem no que a plataforma traz, então uma build nativa usa a própria
fonte do sistema com a mesma escala.

| Família              | Pilha                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `font-sans` (padrão) | Inter → Segoe UI Variable Text → Segoe UI → Adwaita Sans → Cantarell → system-ui → sans-serif     |
| `font-mono`          | JetBrains Mono → Cascadia Mono → Adwaita Mono → ui-monospace → SFMono-Regular → Menlo → monospace |

O tema esvazia a escala tipográfica do Tailwind, então só estes seis tamanhos existem:
`text-lg` não gera nada. O teste de conformidade o rejeita, e também um tamanho
arbitrário como `text-[13px]`.

| Utilitário      | Tamanho / linha  | Peso            | Uso                                                                                             |
| --------------- | ---------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `text-headline` | 28 / 36, −0.01em | 600             | Uma saudação por tela: o título da Home, o título de um passo do onboarding.                    |
| `text-title`    | 20 / 28          | 600             | Títulos de página e de diálogo; as contagens grandes de um resumo de saúde.                     |
| `text-base`     | 16 / 24          | 600             | Títulos de seção dentro de uma página; títulos de cards grandes.                                |
| `text-sm`       | 14 / 20          | 400 · 500 · 600 | O padrão: campos, itens de menu, títulos de chat, texto das mensagens. Rótulos de botão em 500. |
| `text-xs`       | 12 / 16          | 400 · 500       | Descrições, metadados, badges, toasts, botões `sm`. O menor tamanho para texto corrido.         |
| `text-micro`    | 11 / 16          | 500             | O piso do texto. Metadados em mono, contadores e os títulos de grupo `.micro-label`.            |

- Os pesos são 400 (texto), 500 (rótulos, botões, o item atual) e 600 (títulos):
  `font-medium` e `font-semibold`. Não existe bold; `font-bold` e os pesos light são
  rejeitados.
- Só a primeira letra maiúscula (sentence case) em todo lugar. A única caixa-alta é
  `.micro-label` (mono, 11px, 500, espaçamento de 0.06em, `fg-subtle`), aplicada pela
  classe, nunca por `uppercase` ou `tracking-*` num elemento; o teste de conformidade
  rejeita `uppercase` e `tracking-wide` / `-wider` / `-widest` no código.
- Dois glifos desenhados dentro de um quadrado ficam abaixo de 11px, e são as únicas
  entradas do mapa `ALLOWED` do teste de conformidade: o monograma do `ToolAvatar` (8 a
  10px nos quadrados pequenos) e o número dentro do `ContextRing` de 20px (8px). Nenhum
  dos dois é texto corrido ([decisões 6 e 26](./decisions.md)).
- O tamanho do próprio chat é uma preferência: `--chat-font-size` (13, 14 ou 16px)
  controla só o corpo das mensagens (`.chat-message-body`).
- Mono é para conteúdo técnico (chips `key: value`, caminhos, código, saída de tools) e
  para rótulos de grupo. Títulos, botões e prosa nunca são mono.
- `cn()` em `lib/utils.ts` conhece os nomes próprios (`text-micro`, `text-title`,
  `text-headline`, `shadow-popover`, `shadow-dialog`), então mesclar `text-title` com
  `text-danger` mantém os dois.

## Espaçamento

Uma grade de 4px. A escala do próprio Tailwind já é uma; o sistema a estreita.

| Passo | px | Uso típico                                                                |
| ----- | -- | ------------------------------------------------------------------------- |
| `0.5` | 2  | Só ajustes ópticos (um `mt-0.5` sob um rótulo de duas linhas).            |
| `1`   | 4  | Padding de menu; o espaço dentro de um chip.                              |
| `1.5` | 6  | O espaço entre um ícone e seu rótulo numa linha densa.                    |
| `2`   | 8  | Espaço entre controles vizinhos; ícone e rótulo em botões.                |
| `3`   | 12 | Padding horizontal de botões e campos; espaço entre linhas de formulário. |
| `4`   | 16 | Padding de card; margens laterais da barra lateral e do cabeçalho.        |
| `5`   | 20 | Espaço entre grupos dentro de um card.                                    |
| `6`   | 24 | Padding de diálogo e de página; espaço entre cards.                       |
| `8`   | 32 | Espaço entre seções de página.                                            |
| `12`  | 48 | Respiro acima de estados vazios e saudações.                              |

`2.5` e `3.5` (10px, 14px) ficam fora da grade. O teste de conformidade os rejeita como
passos de padding, margin, gap e `space-*` (`px-2.5`, `gap-3.5`, `-mt-2.5`). Um tamanho
não é espaçamento: `size-3.5` para a caixa de um ícone de 14px é permitido.

A prosa no chat fica limitada a uma largura de leitura de `max-w-2xl` (672px) dentro da
coluna do chat; veja [Layout](#layout). A densidade do chat é uma preferência
(`[data-chat-density]`: compact, default, comfortable) que muda só o espaço entre turnos
(`--chat-message-gap`) e entre os passos de um turno (`--timeline-row-gap`,
`--timeline-block-gap`); veja [`patterns.md`](./patterns.md#densidade).

### Alturas

| Utilitário | px | Uso                                                                                                                 |
| ---------- | -- | ------------------------------------------------------------------------------------------------------------------- |
| `h-5`      | 20 | Badges, keycaps (`KbdHint`), o trilho do switch.                                                                    |
| `h-6`      | 24 | Os chips `key: value` (`.terminal-chip`, `.composer-chip`, que a definem no CSS).                                   |
| `h-7`      | 28 | Controles compactos: botões `sm` e `icon-sm`, os chips de tool do compositor, o botão de copiar do bloco de código. |
| `h-8`      | 32 | O padrão: botões `md` e `icon`, campos, gatilhos de Select, itens de menu, linhas de navegação, segmentos.          |
| `h-9`      | 36 | Abas sublinhadas (`Tabs`, `TabNav`).                                                                                |
| `h-10`     | 40 | Botões `lg`: as ações das telas de login, cadastro e onboarding.                                                    |
| `h-12`     | 48 | O cabeçalho e a linha da marca na barra lateral, para que compartilhem a mesma linha de base.                       |

32px é a altura de controle do próprio WinUI e fica a dois pixels da do libadwaita.

### Alvos de toque

As alturas acima são os tamanhos para **ponteiro preciso**. Sob
`@media (pointer: coarse)`, uma regra fora de camada em `index.css` dá a todo `button`,
`a`, `select`, `textarea`, `[role="button"]` e `input` do tipo texto um `min-height` e um
`min-width` de 44px, então uma tela de toque fica mais alta do que a tabela. Ela fica fora
de camada para que um utilitário como `min-h-8` numa linha de menu não a desfaça, e é por
isso que ela nomeia suas exceções:

- Inputs de checkbox, radio e range, e o switch (um checkbox com `role="switch"`),
  mantêm o tamanho desenhado. `Checkbox` e `Radio` ampliam a área de toque para 40px com
  um pseudo-elemento (`pointer-coarse:after:-inset-3`); uma linha que envolve um deles
  num `<label>` vira o alvo com `pointer-coarse:min-h-11`.
- Um input range mantém seu trilho de 6px.
- O botão de copiar de 28px do bloco de código (`.copy-code-btn`) continua com 28px para
  não cobrir as primeiras linhas de um trecho.
- Links dentro da prosa em markdown continuam como texto inline.

Daí seguem mais duas regras. A timeline eleva `--timeline-row-height` para 44px num
ponteiro impreciso, para que um nó continue centralizado numa linha que o piso deixou
mais alta (um `TimelineRow` estático recebe a mesma altura via
`min-h-(--timeline-row-height)`). Tudo que aparece no hover é mostrado em repouso no
toque (`pointer-coarse:opacity-100`, como em `features/chat/lib/turn-action-reveal.ts`,
ou `pointer-coarse:flex` / `pointer-coarse:inline-flex`), e keycaps não são desenhados
(`KbdHint` carrega `pointer-coarse:hidden`). `tests/unit/stylesheet-cascade.test.ts`
fixa as exceções e a altura da timeline; a [decisão 15](./decisions.md) traz o
raciocínio.

## Raio

Quatro raios por papel, mais a pílula. O tema esvazia a escala do próprio Tailwind,
então `rounded-xl` e maiores não geram nada. O teste de conformidade os rejeita, e também
um `rounded` puro sem tamanho.

| Utilitário     | px | Aplica-se a                                                                                                                                                                             |
| -------------- | -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rounded-xs`   | 4  | Checkboxes, keycaps, código inline, miniaturas, skeletons.                                                                                                                              |
| `rounded-sm`   | 6  | **Tudo que é clicável**: botões, campos, Select, chips, itens de menu, linhas de navegação, segmentos.                                                                                  |
| `rounded-md`   | 8  | Contêineres: cards, blocos de tool, menus, toasts, blocos de código, callouts.                                                                                                          |
| `rounded-lg`   | 12 | Superfícies grandes: diálogos, o compositor, a paleta de comandos, a mensagem do usuário, os cards de login e cadastro.                                                                 |
| `rounded-full` | —  | Marcas de status e glifos redondos: badges, pontos de status, spinners, barras de progresso, as barras de destaque, o radio, o switch e o slider. Nenhum botão, chip ou linha é pílula. |

Um controle e o contêiner em que está diferem por um degrau (um botão `rounded-sm` num
card `rounded-md`), para que os cantos nunca pareçam chutados. O `ToolAvatar` muda o
canto conforme o tamanho, de `rounded-xs` no quadrado menor a `rounded-lg` no maior.

## Elevação

Flat por padrão. Um card, um botão e o compositor contam com superfície + stroke;
nenhum deles projeta sombra. Só o que **flutua** projeta.

| Utilitário       | Escuro                            | Claro                               | Uso                                                                                                                           |
| ---------------- | --------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `shadow-popover` | `0 4px 16px rgba(0, 0, 0, 0.36)`  | `0 4px 16px rgba(30, 20, 5, 0.1)`   | Menus, listboxes e popovers (`.dropdown-panel`), toasts e controles que flutuam sobre a transcrição (ir para o mais recente). |
| `shadow-dialog`  | `0 16px 40px rgba(0, 0, 0, 0.48)` | `0 16px 40px rgba(30, 20, 5, 0.14)` | Diálogos e a paleta de comandos.                                                                                              |

São utilitários próprios apoiados em `--elevation-popover` / `--elevation-dialog`,
porque o Tailwind embute um valor de tema `--shadow-*` no utilitário e uma sobrescrita
da variável por tema nunca chegaria a ele. Todo outro nome de sombra (`shadow-sm` até
`shadow-2xl`, `drop-shadow-*`) é rejeitado.

Superfícies flutuantes são **sólidas**: `bg-surface-raised border border-stroke`. Sem
transparência e sem desfoque de fundo. Flyouts do WinUI e popovers do libadwaita são
desenhados assim, então um port nativo não tem efeito de material para desfazer. A
classe `.dropdown-panel` reúne tudo isso para menus e listboxes; `DIALOG_SURFACE_CLASS`
em `Dialog.tsx` faz o mesmo para diálogos.

## Estado

- **Foco**: um contorno `focus` sólido de 2px, deslocado 2px, aplicado globalmente a
  `:focus-visible`. Componentes não desenham o próprio anel. Campos de texto e gatilhos
  de Select o trocam por uma mudança de borda (`focus:outline-none focus:border-focus
  focus:ring-1 focus:ring-focus`). Alguns controles mudam o mesmo anel de lugar: abas
  sublinhadas o puxam para dentro (`-outline-offset-2`) para que a faixa com rolagem não
  o corte, um slider o desenha no polegar, o switch no trilho (o input em si fica
  visualmente oculto), um chip do compositor em volta do `<label>` que envolve seu
  `<select>` (`.composer-chip:has(:focus-visible)`), e um controle sobre `scrim-media` o
  desenha em `on-scrim-media`.
- **Hover** muda só a cor, em 120ms: o preenchimento e, num controle cujo texto repousa
  em `fg-muted` (uma aba inativa, um segmento não selecionado, um chip), o texto sobe
  para `fg`. Sem escala, sem elevação, sem brilho e sem `transition-all`. O `hover:` do
  Tailwind só vale para um ponteiro capaz de hover, e os preenchimentos de hover escritos
  à mão em `index.css` (chips do compositor, o polegar do slider, o botão de copiar)
  seguem a mesma condição (`@media (hover: hover)`), então um controle tocado não fica
  aceso. O único hover que muda de matiz é o de `subtle-danger`: ele repousa em
  `fg-muted` e passa a texto `danger` sobre um preenchimento `danger-subtle` no hover,
  no foco por teclado e ao ser pressionado ([decisão 22](./decisions.md)). Um
  `MenuItem` com `tone="danger"` tem texto `danger` em repouso e recebe o preenchimento
  `danger-subtle` no hover. O botão `danger` clareia (`brightness-110`) em vez de passar
  para outro token.
- **Pressionado**: `accent-pressed` e `control-pressed` são um degrau mais escuros que o
  preenchimento em repouso. `fill-pressed` é uma camada mais fina que `fill-hover`.
- **Desabilitado**: botões ficam cinza neutro (`fill-selected` + `fg-subtle`) nas
  variantes preenchidas (`primary`, `secondary`, `danger`); as discretas (`subtle`,
  `subtle-danger`) não têm preenchimento de saída e só passam o texto para `fg-subtle`,
  porque um bloco pareceria a linha em hover ou selecionada
  ([decisões 10 e 14](./decisions.md)). Um botão que está apenas *carregando*
  mantém a cor e mostra o spinner; `aria-busy` distingue os dois casos. Outros controles
  desabilitados (campos, Select, checkbox, switch, slider, chips, itens de menu) caem
  para 50% de opacidade. O critério é se a coisa desabilitada carrega informação
  ([decisão 21](./decisions.md)); dois tipos de linha são conteúdo, e não um
  controle desligado, e não esmaecem:
  - Uma linha desabilitada cujo nome é informação (um modelo ligado a outro provedor, um
    runner indisponível, uma distribuição já usada ou uma CLI sem login num
    `PickOneRow`) mantém o ícone ou o ponto de identidade com força total (um modelo
    bloqueado ganha um cadeado), e o nome passa de `fg` para `fg-muted`. Ela perde o
    hover e mostra `cursor-not-allowed`; o motivo fica ao lado ou no topo da lista
    ([decisões 17 e 21](./decisions.md)).
  - Um chip do compositor *travado* porque o chat já tem turnos (o agente, o ambiente) é
    um `LockedChip`: texto com força total, sem chevron
    ([decisão 18](./decisions.md)). Só um chip carregando ou com falha
    esmaece.
- **Selecionado** é um `fill-selected` neutro mais uma marca de destaque. Numa lista
  vertical (a barra lateral, a navegação de settings, os passos do onboarding,
  `PickOneRow`, os cards de tema, a lista de sessões do terminal) a marca é uma barra de
  3px na borda inicial (`SELECTION_BAR` em `components/ui/selection-bar.ts`). Uma aba
  sublinhada e um segmento selecionado de `SettingsSegmented` levam uma barra de 2px na
  borda inferior.
- **Ligado** (um chip de alternância com `aria-pressed="true"`) usa `fill-selected`, a
  mesma camada de um menu aberto, então ganha uma segunda pista que o estado aberto não
  tem: o ícone inicial do chip assume a cor do runner do compositor. Um chip cujo estado
  nada mais mostra (Criar imagens) também leva um check ao lado do rótulo.

## Movimento

| Token              | Valor                             | Uso                                                                                                                                                                |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--duration-quick` | 120ms                             | Retorno de hover e foco, e abertura de menus e popovers. Um `transition-colors` puro usa este valor.                                                               |
| `--duration-base`  | 200ms                             | O painel da paleta de comandos e do lightbox, seções expansíveis, toasts, entrada de cards, o movimento do botão do switch, a borda do compositor mudando no foco. |
| `--duration-slow`  | 320ms                             | Um painel deslizante (a barra lateral no celular).                                                                                                                 |
| `ease-standard`    | `cubic-bezier(0.2, 0, 0, 1)`      | Tudo que se move hoje, e o timing padrão de um `transition-*` puro.                                                                                                |
| `ease-emphasized`  | `cubic-bezier(0.05, 0.7, 0.1, 1)` | Uma acomodação mais firme, reservada para uma entrada que deve parecer deliberada. Nada a usa ainda.                                                               |

O Tailwind não tem namespace `--duration-*`, então as durações vivem em `:root` e são
escritas `duration-(--duration-base)` numa classe ou `var(--duration-base)` no CSS.
`index.css` também aponta `--default-transition-duration` e
`--default-transition-timing-function` para `--duration-quick` e `ease-standard`, o que
reajusta de uma vez todo `transition-colors` puro.

A animação em JavaScript (`motion/react`) lê os mesmos valores de
`lib/motion/tokens.ts`, que `tests/unit/lib/motion/tokens.test.ts` mantém igual à folha
de estilo. Componentes pegam um preset de `useMotionPresets()` em vez de escrever uma
transição (`lib/motion/variants.ts` os define): menus, Select e `ChipSelect` descem 6px a
partir do gatilho (`popoverBelow`), popovers do compositor sobem 8px (`popoverAbove`), o
painel da paleta de comandos e do lightbox da galeria desce 8px (`dialogPanel`), e toasts
e o botão de ir para o mais recente sobem 8px (`fadeRise`), cada um com um fade; popovers
e esses painéis também crescem a partir de 96–97% da escala. Seções expansíveis abrem
pela altura (`collapse`), e as grades de cards da Home sobem 6px por card, com 40ms de
intervalo (`useCardGrid()`). Nada quica.

`prefers-reduced-motion` anula toda animação e transição de CSS, e `useMotionPresets()`
troca para presets parados, porque a regra de CSS não alcança a animação em JavaScript.

## Ícones

Lucide (`lucide-react`), com o traço padrão de 2px e pontas arredondadas. Os tamanhos
são constantes em `@/lib/icon-sizes`:

| Constante | px | Uso                                                                                               |
| --------- | -- | ------------------------------------------------------------------------------------------------- |
| `ICON_SM` | 14 | Dentro de chips, badges e linhas compactas; glifos de status inline.                              |
| `ICON_MD` | 16 | Botões, itens de menu, linhas de navegação, glifos de callout.                                    |
| `ICON_LG` | 20 | Os blocos da navegação no celular, o botão de menu do cabeçalho, glifos de toast, estados vazios. |

Escolha um dos três; não escreva um `size` literal. A única exceção é um check desenhado
dentro de uma caixa de 16px (`Checkbox`, `ChoiceButton`), que tem 12px. O teste de
conformidade aplica a regra a ícones de `EmptyState`. Ícones herdam a cor do texto da
linha; em repouso, ela é `fg-muted`. Uma build nativa os troca por Segoe Fluent Icons ou
ícones simbólicos do Adwaita com as mesmas medidas.

## Layout

- A barra lateral tem 256px por padrão (240px a 420px, redimensionável pela borda;
  `CHAT_SIDEBAR_WIDTH_*` em `@mangostudio/shared/workspaces`), `bg-sidebar`, fechada por
  uma borda `stroke`. Abaixo de `md` ela vira um painel deslizante com `scrim`.
- O cabeçalho é `h-12` em todos os breakpoints, `bg-canvas` com uma borda inferior
  `stroke`. Ele leva o runner, a máquina (a partir de `sm`) e o workspace (a partir de
  `md`) à esquerda, e a paleta de comandos e as ações da conta à direita. Abaixo de `md`,
  o lado direito é um botão Novo chat e um único menu de conta.
- O painel de workspace (git, GitHub, to-dos, terminal) se fixa à direita a partir de
  1024px: uma faixa de ícones `bg-sidebar` de 48px e um painel `bg-surface`, com 360px por
  padrão (280px a 640px, redimensionável; `WORKSPACE_PANEL_WIDTH_*`). Abaixo de 1024px ele
  é uma gaveta sobre um `scrim`.
- Superfícies de leitura (chat, settings) centralizam o conteúdo numa única coluna. A do
  chat é `max-w-4xl` (896px) dentro de uma margem lateral `px-3 sm:px-4 md:px-6`
  (`CHAT_COLUMN_CLASS` e `CHAT_GUTTER_X_CLASS`), e a transcrição, os avisos acima do
  compositor e o compositor ficam todos nela, então as bordas se alinham em qualquer
  largura. Os balões de prosa dentro dela param em `max-w-2xl`.
  As páginas de settings usam um layout de duas colunas (uma navegação de 14rem +
  conteúdo) a partir de `lg`, dentro de `max-w-6xl`. A biblioteca é uma seção do guarda-
  chuva Ambientes, não uma página própria: ela fica sob o título e a faixa de abas desse
  guarda-chuva, com um segundo `TabNav` só dela (tipos, settings, locais) e sem
  navegação lateral, para que uma matriz larga mantenha a largura total. A linha acima da
  segunda faixa é o mesmo `EnvironmentScopeHeader` com que toda aba de Ambientes abre: a
  descrição, o seletor de máquina e um único Verificar novamente. Os backups abrangem todas
  as máquinas, então essa página dispensa o seletor e o Verificar novamente.
