# Decisões

Os motivos por trás do sistema, um por entrada. Uma decisão muda com uma entrada nova que a
substitui, restringe ou amplia, não editando a conclusão da antiga; a linha de status da
entrada antiga cita a entrada que a mudou.

Os caminhos de código são relativos a `apps/frontend/src` e os caminhos de teste a
`apps/frontend`.

## 1. Flat, porque ports nativos não podem ter nada a desfazer

**Status:** aceita · **Substitui:** o visual de vidro e gradiente.

A interface anterior se apoiava em translucidez (`backdrop-blur` em 33 elementos), um
gradiente de manga no botão principal, sombras de brilho coloridas e `shadow-2xl` nos
diálogos e no compositor. Nada disso tem um equivalente em WinUI 3 ou libadwaita com a mesma
aparência, então cada tela nativa teria de imitar o efeito ou divergir visivelmente da web.
Superfícies sólidas separadas por um hairline são o denominador comum, e também cansam menos
a vista ao longo de uma sessão de oito horas.

**Consequência:** nada de gradiente, nada de `backdrop-filter`, nada de sombra colorida. O
teste de conformidade os rejeita. Só superfícies que flutuam projetam sombra, e só uma de
duas neutras (`shadow-popover`, `shadow-dialog`); todo outro utilitário de sombra também é
rejeitado. O logo (uma manga ilustrada, `assets/logo.png`) é o único recurso não flat; uma
marca flat é uma decisão de marca e continua em aberto.

## 2. Tokens semânticos, com nomes de papéis

**Status:** aceita · **Substitui:** os nomes no estilo Material `surface-container-*`,
`on-surface`, `primary`.

Os nomes antigos não diziam para que serviam: `surface-container-high` era um card num
arquivo, um campo noutro e um preenchimento de hover num terceiro, e mais de 40 variantes de
opacidade (`/10` … `/60`) aproximavam tudo que ficava entre eles. Os tokens novos são papéis
(`canvas`, `surface`, `control`, `fill-hover`, `stroke`, `fg-muted`), cada um com um só
significado e um equivalente documentado em WinUI / libadwaita. Modificadores de opacidade
sobre eles são rejeitados; um tom é um token.

**Consequência:** cerca de 3.500 ocorrências de classe foram migradas mecanicamente e depois
revisadas por área; os nomes antigos foram banidos para não voltarem.

## 3. Quatro raios, uma regra

**Status:** aceita.

Sete raios estavam em uso (`rounded-sm` … `rounded-3xl`), e campos e Selects ficavam lado a
lado com raios diferentes. A regra é por papel: 6px (`rounded-sm`) para tudo que é
clicável, 8px (`rounded-md`) para contêineres, 12px (`rounded-lg`) para superfícies grandes,
4px (`rounded-xs`) para miniaturas, e `rounded-full` só para marcas de status e glifos
redondos (pontos, badges, o radio, o switch), nunca para um botão, chip ou linha. O tema
esvazia a escala de raios do próprio Tailwind, então um `rounded-2xl` esquecido compila para
um canto reto em vez de manter um tamanho em silêncio, e o teste de conformidade o rejeita.

## 4. Inter e JetBrains Mono; Manrope removida

**Status:** aceita.

Três famílias (Manrope para títulos, Inter para o corpo, JetBrains Mono) viraram duas. A
Inter é a base da Adwaita Sans e convive com a Segoe UI Variable sem destoar, então uma build
nativa pode trocar pela fonte do sistema mantendo a mesma escala. Os títulos usam Inter em 600. Isso também tira um arquivo de fonte do bundle e um preload do `index.html`.

## 5. Um controle de 32px, um cabeçalho de 48px

**Status:** aceita.

Os controles tinham de 36 a 42px, conforme o arquivo, e o cabeçalho tinha 12px ou 16px de
padding vertical, conforme o breakpoint. 32px é a altura de controle do WinUI e fica a dois
pixels da do libadwaita; 28px é o degrau compacto e 40px fica reservado para a ação principal
de uma tela. No `Button`, esses são os tamanhos `md`/`icon` (32px), `sm`/`icon-sm` (28px) e
`lg` (40px). As abas sublinhadas são a única linha de 36px (`h-9`). O cabeçalho tem 48px
fixos, e a linha da marca na sidebar o acompanha para que os dois compartilhem uma linha de
base.

## 6. Texto mínimo de 11px, sem texto esmaecido

**Status:** aceita · **Restringida por:** 26, para o número do anel de contexto.

Cerca de 200 elementos de texto tinham 10px e vários tinham 9px ou 8px; o texto secundário
era produzido por esmaecimento (`text-on-surface-variant/40`), que caía para cerca de 2:1. O
menor tamanho agora é `text-micro` (11px) para metadados em mono e rótulos de grupo,
`text-xs` (12px) para texto corrido, e as três cores de texto são tokens fixos que passam de
4.5:1 em todas as superfícies. Monogramas de avatar dentro de tiles de 16–24px são glifos,
não texto corrido, e são uma exceção explícita e documentada.

## 7. Send é sempre o destaque

**Status:** aceita · **Substitui:** um botão de envio com a cor do runner.

O compositor usava a cor do runner na moldura _e_ no botão Send, o que exigia escurecer com
um `color-mix` por tema para passar de 4.5:1 com texto branco. A identidade do runner
(`--composer-accent`, definida a partir de `features/chat/lib/composer-accent.ts`) continua
aparecendo na borda em foco, na marca do prompt, no cursor de texto, no chip do runner e no
glifo inicial de um chip de tool pressionado; Send é a ação principal do produto e é sempre
`accent`. Uma ação principal, uma cor.

## 8. Interação neutra, destaque só para "principal" e "atual"

**Status:** aceita · **Restringida por:** 22, para o hover do `subtle-danger`.

O hover e a seleção em menus, listas e na sidebar puxavam para o destaque
(`hover:bg-primary/10 hover:text-primary`). Hover e pressionado agora são lavagens
translúcidas neutras (`fill-hover`, `fill-pressed`, `fill-selected`), e o destaque aparece só
no botão principal, na barra da página atual, em controles marcados e no foco. Isso mantém o
destaque significativo e acompanha o comportamento das listas nativas.

## 9. Abas sublinhadas

**Status:** aceita.

As faixas de abas desenhavam uma aba em forma de pasta, com preenchimento tingido e um
sublinhado. O sublinhado agora é a única marca da aba atual (`SelectorBar` /
`AdwViewSwitcher`): um traço `accent` de 2px sobre o divisor da faixa. `Tabs` (botões) e
`TabNav` (links do router) o desenham a partir do mesmo `TAB_CLASSES` em
`components/ui/Tabs.tsx`, então as duas faixas não podem divergir.

## 10. Botões desabilitados ficam cinza

**Status:** substituída em parte pela 14, para `subtle` e `subtle-danger`; ainda aceita para
`primary`, `secondary` e `danger`.

Um botão principal desabilitado era a manga esmaecida a 50%, que parece uma outra cor de
marca, mais apagada. Botões desabilitados são neutros (`fill-selected` + `fg-subtle`) em
todas as variantes, como os controles nativos são desenhados. Um botão que está apenas
_carregando_ mantém a cor e mostra um spinner.

## 11. Um anel de foco

**Status:** aceita.

Os controles desenhavam seus próprios tratamentos de foco (um anel num lugar, uma borda em
outro, um `outline-offset` num terceiro). Agora `:focus-visible` desenha globalmente um
contorno `focus` de 2px com 2px de afastamento, e os componentes não desenham anel próprio.
Campos de texto e triggers de Select são a exceção: eles removem o contorno e passam a
própria borda para `focus` com um anel de 1px
(`focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus`), para que a marca de
foco fique na borda do campo. Alguns lugares deslocam o mesmo anel em vez de desenhar outro:
as abas sublinhadas o puxam para dentro (`-outline-offset-2`) para que a faixa com rolagem
não o corte, o slider o desenha no seu polegar, um controle cujo elemento focado fica
escondido dentro da caixa que ele desenha (`Toggle`, `PickOneRow`, um segmento de radio, um
chip do compositor em volta do seu `<select>`) o desenha nessa caixa, e um controle sobre
`scrim-media` o desenha em `on-scrim-media` (decisão 23).

## 12. Um `Callout` para avisos no fluxo

**Status:** aceita.

Os avisos eram montados arquivo a arquivo a partir de `border-warning/35 bg-warning/5` e
coisas parecidas. Um único componente os desenha: uma faixa tingida, um glifo de status e
texto comum, então o tom nunca é carregado por uma borda colorida ou por palavras coloridas.

## 13. Nenhum `color-mix()` nas folhas de estilo

**Status:** aceita.

O bundler rebaixa o `color-mix()` e emite de novo só a primeira declaração misturada de cada
regra, o que já tinha entregado dois bugs que nenhuma verificação percebeu. Todo tom de que o
design precisa agora é um token, então as folhas de estilo não escrevem `color-mix()` nenhum.
`tests/unit/stylesheet-downlevel.test.ts` mantém isso assim.

## 14. Botões discretos desabilitados não ganham preenchimento

**Status:** aceita · **Substitui:** a 10, para `subtle` e `subtle-danger`.

A decisão 10 transformava todo botão desabilitado no tile neutro `fill-selected`. Para um
botão `subtle` essa é a imagem errada: `fill-selected` também é o preenchimento de selecionado
e de hover, então um botão de ícone desabilitado numa fileira de botões flat (a seta para
cima da linha Repository na ordem do painel lateral em Settings › General, ao lado dos irmãos
habilitados) virava o controle mais chamativo da fileira, e parecia o atual. Botões nativos
de toolbar e flat desenham "desabilitado" como texto cinza sem tile, porque nunca tiveram um.

**Consequência:** `primary`, `secondary` e `danger` continuam virando o tile cinza; um botão
`subtle` ou `subtle-danger` desabilitado não ganha preenchimento e só passa o texto para
`fg-subtle`, sobrepondo um `text-danger` do ponto de uso. Um botão carregando continua
intocado (`aria-busy`). Um split button segue a mesma regra nas duas metades: enquanto a
metade principal é o tile cinza, o chevron é `secondary`.

## 15. Alvos de toque têm 44px, exceto onde um controle desenha a própria caixa

**Status:** aceita.

Num ponteiro impreciso, botões, links, `[role="button"]`, selects, textareas e campos de
texto recebem `min-height` e `min-width` de 44px; o ritmo de 32px dos fundamentos é o
contrato do ponteiro preciso. A regra fica fora de camada de propósito, para que um
utilitário numa linha de menu não desfaça um piso de acessibilidade, e pelo mesmo motivo ela
precisa nomear o que não deve tocar.
No início ela valia para todo `input`, o que desenhava o checkbox e o radio de 16px como
quadrados vazios de 44px, o slider como uma barra de 44px, e o botão de copiar por cima das
primeiras linhas de um bloco de código.

**Consequência:** inputs de checkbox, radio e switch, inputs de intervalo, o botão de copiar
do bloco de código e links dentro da prosa em markdown ficam isentos. `Checkbox` e `Radio`
mantêm o desenho de 16px e ampliam a área de clique para 40px com um pseudo-elemento no
input; uma linha que envolve um deles num `<label>` é o seu próprio alvo de 44px
(`pointer-coarse:min-h-11`). Os sliders mantêm o trilho de 6px; um mais alto é uma
reestilização do trilho, não um `min-height`. A timeline eleva `--timeline-row-height` para
44px num ponteiro impreciso, para que os nós continuem centralizados em linhas que o piso
deixou mais altas. `tests/unit/stylesheet-cascade.test.ts` fixa as isenções e a altura da
timeline.

## 16. Um segmento selecionado é neutro, com o destaque como barra

**Status:** aceita.

`SettingsSegmented` desenhava o segmento selecionado como um botão preenchido com o destaque
(`bg-accent text-on-accent`), que é exatamente o `Button` principal. Na página Prompts isso
punha quatro botões manga na tela ao mesmo tempo, dois por arquivo de regra, e no diálogo Add
server o segmento `stdio` e o Save eram do mesmo laranja, então o verdadeiro botão principal
deixava de se destacar. A decisão 8 já diz que o destaque aparece só no botão principal, no
item atual, em controles marcados e no foco; um segmento selecionado é o _item atual_, não um
chamado à ação.

**Consequência:** o segmento selecionado é `fill-selected` com borda `stroke-strong` e `fg`,
e o destaque é uma barra de 2px na borda de baixo, a mesma marca da aba sublinhada
(decisão 9). Os segmentos não selecionados são `control` com texto `fg-muted`. Uma barra em
vez de um check, porque um check muda a largura do segmento quando a escolha se move e a
barra não; o preenchimento sozinho não sobreviveria a uma tela em tons de cinza, e por isso o
segmento o combina com o destaque (o mesmo raciocínio do `SELECTION_BAR` em
`components/ui/selection-bar.ts`, a barra na borda inicial de uma lista vertical). Todos os
pontos de uso mudam junto com o componente.

## 17. Uma linha de menu desabilitada cujo nome é informação desce um degrau de cor, não esmaece

**Status:** aceita · **Restringe:** a seção Estado em `foundations.md`, para linhas de menu ·
**Restringida por:** 18 · **Ampliada por:** 21.

A seção Estado baixa "os outros controles desabilitados" para 50% de opacidade, e o menu de
modelos e o menu de runners seguiram isso: um modelo ligado a outro provedor, um runner que
esta máquina não pode usar, esmaecia como linha inteira. Medidos, os nomes caíam para cerca de
3.4:1 no claro e 4.2:1 no escuro, abaixo do piso de 4.5:1 que o princípio 4 e a decisão 6
definem para texto. Isso serve para um controle que só está desligado (a WCAG o isenta), mas
não aqui: esses nomes são o conteúdo. Eles dizem quais provedores e agentes existem, e a linha
é o único lugar que diz por que estão fora de alcance.

**Consequência:** uma linha de menu desabilitada mantém o ícone e o `cursor-not-allowed`, e o
nome passa de `fg` para `fg-muted`, como já se lê o par recusado do `PermissionSelector`.
Nada esmaece. O motivo é escrito uma vez por menu, não uma vez por linha: uma linha
`text-xs fg-muted` no topo da lista de modelos nomeia o provedor ao qual o chat está ligado, e
o menu de runners mantém a linha de explicação embaixo de cada linha. Todo outro controle
desabilitado (campo, select, checkbox, switch, chip do compositor) mantém a regra dos 50%: um
controle desligado não carrega informação própria.

## 18. Um chip travado pelo histórico do chat afirma um fato; ele não esmaece

**Status:** aceita · **Restringe:** a 17, para os chips do compositor que ela lista, e a seção
Estado em `foundations.md`.

A decisão 17 deixou "chip do compositor" sob a regra dos 50%, e o chip de agente e o chip de
ambiente a seguiam assim que um chat tinha turnos. Medida, a chave `env:` do chip de ambiente
caía para 2.3:1 no claro e o valor para 3.3:1, e um chevron ainda prometia um menu que não
podia abrir. Mas o que o chip diz (em que máquina este chat rodou, quem o respondeu) é
conteúdo, o mesmo tipo de informação que a decisão 17 protege numa linha de menu. Não é um
controle que por acaso está desligado.

**Consequência:** um chip cuja resposta é decidida pelo primeiro turno do chat é um
`LockedChip` (`components/ui/`): chave em `fg-muted`, valor em `fg`, sem chevron, o motivo
como `title` e como texto para leitor de tela. `EnvironmentSelector` recebe uma flag `locked`
(um fato) separada de `disabled` (carregando ou com falha, que ainda esmaece). Ele também
desenha um `LockedChip` quando o ambiente atual é o único, já que não há o que escolher; nesse
caso o motivo diz isso. A regra dos 50% continua valendo para um chip que só está desligado.

## 19. O `control` escuro sobe um degrau acima de `surface-raised`, e o texto sobre ele acompanha

**Status:** aceita.

O `control` escuro (`#2a2723`) ficava sobre `surface-raised` (`#282521`) a 1.03:1, então
dentro de um diálogo o preenchimento de um campo e o corpo do diálogo eram o mesmo cinza, e o
campo parecia um contorno com um sublinhado. Sobre `surface` (General, Context) o mesmo
preenchimento se destacava, o que fazia os diálogos parecerem mais chapados que as páginas. O
preenchimento não pode ser uma lavagem translúcida: ele também fica sobre blocos de código e
sob o botão de copiar, e um controle flutuante ou sobreposto precisa continuar sólido.

**Consequência:** o `control` escuro é `#2f2c27` e o `control-hover` `#37342e`, um degrau
acima do corpo do diálogo; `control-pressed` assume o antigo valor de repouso, um degrau mais
escuro. Um preenchimento mais claro cobra seu preço das linhas e do texto desenhados sobre
ele, então o `stroke-strong` escuro sobe para `#857f73` (3:1 sobre `control` e seu hover) e o
`fg-subtle` escuro para `#a29b91` (os placeholders continuam acima de 4.5:1 sobre `control` e
`control-hover`), com o `fg-muted` escuro em `#b0a99e` para seguir um degrau nítido acima. Os
três só ficam mais claros sobre uma superfície escura, então nada mais perde contraste.

## 20. A lavagem de warning do tema claro é âmbar

**Status:** aceita.

O `warning-subtle` claro era a primeira cor de texto `warning` do tema claro, `#b45309`, a 10%
(`#b453091a`); a cor de texto desde então escureceu para `#92400e`. Sobre `canvas` essa
lavagem dá RGB(239, 228, 216), contra (242, 228, 223) do `danger-subtle`: um aviso de login e
uma falha tinham o mesmo rubor, diferenciados só por um glifo de 16px. Aprofundar o
preenchimento não era uma opção (`fg-subtle` sobre a faixa ficava em 4.6:1, sem folga).

**Consequência:** a lavagem é âmbar, `#ffbf00` a 16% (`#ffbf0029`), mais amarela e mais clara
ao mesmo tempo, então `fg-subtle`, `accent-fg` e o texto `warning` ganham contraste sobre ela.
O tema escuro já era uma lavagem amarela.

## 21. Onde um controle desabilitado ainda diz algo, o texto desce um degrau; ele não esmaece

**Status:** aceita · **Amplia:** a 17, para `PickOneRow`.

A decisão 17 manteve a opacidade para "todo outro controle desabilitado", e `PickOneRow`
seguiu isso: uma distribuição WSL que outro ambiente já usa esmaecia como linha inteira, e o
"Choose who answers" do onboarding esmaecia o ponto de identidade de uma CLI sem login. Essas
linhas são o mesmo caso das linhas de menu da 17. O nome diz o que existe, e uma CLI sem login
é justamente a linha sobre a qual a pessoa precisa agir, então ela tem de continuar legível.

**Consequência:** o critério é se a coisa desabilitada carrega informação. Se carrega, uma cor
de texto esmaecida faz o trabalho que a opacidade fazia: um `PickOneRow` desabilitado mantém o
glifo, passa o nome de `fg` para `fg-muted`, perde o hover, não pode receber foco e mostra
`cursor-not-allowed`. O menu de runners, já coberto pela 17, também mantém com força total o
ponto de identidade de cada linha desabilitada. Comentários no código que aplicam esta regra
citam a decisão 17, onde o raciocínio está. Um controle que só está desligado (`Input`,
`Select`, `Checkbox`, `Radio`, `Toggle`, `ChipSelect`, um `MenuItem` comum, `Chip`) continua
caindo para 50%, e os botões seguem a 10 e a 14, que usam cor, não opacidade.

## 22. `subtle-danger` repousa em `fg-muted` e vira `danger` quando alcançado

**Status:** aceita · **Substitui:** o `subtle-danger` com texto `danger` em repouso.
**Restringe:** a 8 e o item Hover em `foundations.md`, para esta única variante.

O `subtle-danger` desenhava inicialmente o texto em `danger` em repouso. É a variante para uma
ação destrutiva que não é a confirmação final (Remove numa regra, a lixeira numa linha da
sidebar), então ela se repete ao longo de uma lista. Uma lista em que toda linha termina numa
lixeira vermelha é uma coluna de vermelho que grita mais alto que as linhas, e gasta
`danger`, uma cor de status, em algo que não aconteceu.

**Consequência:** em repouso ele é `fg-muted`, como qualquer ação discreta de linha. No hover,
no foco por teclado (`focus-visible`, não `focus`, para que um clique de mouse não deixe a
linha tingida) e ao pressionar, o texto passa para `danger` sobre um preenchimento
`danger-subtle`. É o único hover que muda de matiz, uma exceção tanto ao item Hover (um hover
muda o preenchimento e, no máximo, sobe o texto esmaecido até `fg`) quanto ao hover neutro da
decisão 8: a cor aparece quando a ação está prestes a acontecer. Desabilitado, ele segue a 14. Um ponto de uso nunca o monta a partir de `subtle` mais `text-danger`.

## 23. Controles sobre uma imagem usam tokens sem tema

**Status:** aceita.

O Close do lightbox da galeria e o download de um tile ficavam sobre o véu `scrim-media`
usando `secondary`. O véu é o mesmo preto nos dois temas, porque uma fotografia não tem tema,
mas o preenchimento `control` de `secondary` segue o tema: no tema claro ele desenhava um tile
branco vivo sobre quase preto, a coisa mais clara da tela depois da imagem, enquanto o tema
escuro desenhava um tile discreto. O anel `focus` do tema, um marrom escuro no claro,
praticamente sumia sobre o véu. Escrever `bg-white/16` no lugar é o que o teste de
conformidade rejeita, e `color-mix()` numa folha de estilo é o que a 13 rejeita.

**Consequência:** `scrim-media`, `on-scrim-media`, `fill-media-hover` e `fill-media-pressed`
têm o mesmo valor nos dois temas. Um controle sobre o véu é um botão `subtle` mais
`MEDIA_CONTROL_CLASS` (`features/gallery/components/media-control.ts`): glifo e contorno de
foco em `on-scrim-media`, `fill-media-*` para hover e pressionado. O Download do lightbox
continua `primary`, com o mesmo contorno `on-scrim-media`. Texto sobre uma imagem fica sobre
`scrim-media`, nunca sobre `bg-black/…`.

## 24. Nenhum valor de cor arbitrário em strings de classe

**Status:** aceita · **Amplia:** a 2 ("um tom é um token") para valores arbitrários.

O Tailwind aceita qualquer cor entre colchetes: `bg-[#f5a623]`, `text-[rgb(…)]`,
`border-[var(--color-accent)]`, `bg-[color-mix(…)]`. Cada uma é uma cor que nenhum token
registra. Ela não muda com o tema, o `design-token-contrast.test.ts` nunca a vê, e um
`color-mix()` numa classe passa pelo mesmo rebaixamento que a 13 descreve. A lista de tokens
em `foundations.md` só é um contrato se for a única forma de nomear uma cor.

**Consequência:** o teste de conformidade rejeita um utilitário de cor cujo valor é um colchete
que começa com `color:`, `#`, `rgb(`, `rgba(`, `hsl(`, `hsla(`, `oklch(`, `color-mix(` ou
`var(--color-` em qualquer arquivo `.ts` ou `.tsx`. Um tom de que o design precisa é um token
em `index.css` e uma linha em `foundations.md`. O mesmo teste já rejeita cores cruas da paleta
(`text-red-500`) e sobreposições cruas de `black` / `white`, e o tema esvazia a paleta do
Tailwind (`--color-*: initial`), então uma classe de paleta compila para nada.

## 25. Toasts empilham no canto superior direito

**Status:** aceita · **Substitui:** uma pilha no canto inferior direito.

A pilha ficava no canto inferior direito, por cima do botão Send do compositor e da lista de
arquivos do painel do workspace. Um toast fica parado enquanto o ponteiro está sobre ele,
então ir até o Send o mantinha ali. O canto inferior é onde mora a ação principal de uma
região; o canto superior direito de uma página é margem ou o título de um painel.

**Consequência:** a pilha fica fixa em `top-16 right-4`, 16px abaixo do cabeçalho de 48px,
com 360px de largura e nunca mais larga que a tela. Ela ainda some depois de 4s e pausa
enquanto o ponteiro ou o foco está nela.

## 26. O número do anel de contexto é um glifo, como um monograma de avatar

**Status:** aceita · **Restringe:** a 6.

A decisão 6 citou os monogramas de avatar como o único texto abaixo de 11px. A porcentagem
desenhada dentro do `ContextRing` de 20px de uma linha da sidebar é o mesmo tipo de coisa: um
número que pertence ao desenho, não texto corrido. Ele carrega o valor nas porcentagens
baixas, quando o arco é só um ponto.

**Consequência:** o número tem 8px, semibold, em `fg` em vez de uma cor esmaecida, já que texto
esmaecido desse tamanho não é legível. `ContextRing.tsx` é a segunda entrada na lista
`ALLOWED` do teste de conformidade para a regra da escala tipográfica, com esse motivo. O
compositor, que tem espaço, passa `showValue={false}`: o anel cai para um glifo de 16px e o
número é impresso ao lado dele em 12px.
