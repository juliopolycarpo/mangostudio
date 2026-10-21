# Migração e conformidade

O registro de como o `apps/frontend` passou do vocabulário no estilo Material, de vidro e
gradiente, para o flat, as regras que o código novo segue para continuar nele e como
adicionar uma exceção deliberada. O porquê de cada escolha está em
[`decisions.md`](./decisions.md).

## O que mudou

### Vocabulário

Toda classe da esquerda foi reescrita para o token da direita; o teste de conformidade agora
rejeita os nomes da esquerda.

| Antigo (sufixo do utilitário Tailwind)                         | Novo                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `background`, `surface`, `surface-dim`                         | `canvas`                                                                  |
| `surface-container-low` (a sidebar)                            | `sidebar`                                                                 |
| `surface-container`, `-low`, `-high` (cards, painéis)          | `surface`                                                                 |
| `surface-container-lowest` (campos, chips)                     | `control`                                                                 |
| `surface-container-highest`                                    | `fill-selected` (repouso) · `fill-hover` (hover)                          |
| `hover:bg-surface-container-*`                                 | `hover:bg-fill-hover`                                                     |
| `outline-variant` (+ `/10` … `/60`)                            | `stroke`                                                                  |
| `outline`                                                      | `stroke-strong`                                                           |
| `on-surface`, `on-background`                                  | `fg`                                                                      |
| `on-surface-variant` (+ `/60`, `/70`, `/80`)                   | `fg-muted`                                                                |
| `on-surface-variant/40`, `/50`, `on-surface/30`                | `fg-subtle`                                                               |
| `primary` como preenchimento                                   | `accent`                                                                  |
| `primary` como texto ou ícone                                  | `accent-fg`                                                               |
| `primary/5` … `/30`, `primary-container`, `accent-muted`       | `accent-subtle`                                                           |
| `focus:border-primary…`, `ring-primary…`, `outline-primary`    | `focus`                                                                   |
| `on-primary`                                                   | `on-accent`                                                               |
| `error`, `on-error`                                            | `danger`, `on-danger` (`danger-solid` para um botão sólido)               |
| `error/5` … `/30`                                              | `danger-subtle`                                                           |
| `warning/…`, `success/…` (tons)                                | `warning-subtle`, `success-subtle`                                        |
| `tertiary`                                                     | `info`                                                                    |
| Matizes da paleta do Tailwind (`amber-500`, `blue-400`)        | um token de status ou de destaque                                         |
| `bg-background/80`, `bg-black/60` (sobreposições)              | `bg-scrim`                                                                |
| `bg-black/…`, `text-white` sobre uma imagem                    | `bg-scrim-media`, `text-on-scrim-media`, `fill-media-hover` / `-pressed`  |
| `glass-panel`, `glass-elevated`, `.dropdown-panel` (desfocado) | `surface-raised` + `stroke` + `shadow-popover` (`.dropdown-panel`)        |
| `font-headline`, `font-body`, `font-label`                     | `font-sans` (o padrão: remova a classe)                                   |
| `rounded-xl`, `rounded-lg`                                     | `rounded-md` (contêiner) ou `rounded-sm` (clicável)                       |
| `rounded-2xl`, `rounded-3xl`                                   | `rounded-lg`                                                              |
| `shadow-2xl`, `shadow-lg` …                                    | `shadow-dialog` / `shadow-popover`, ou nenhuma                            |
| `text-[10px]`, `text-[11px]`                                   | `text-micro` (metadados em mono, rótulos de grupo) ou `text-xs`           |
| `text-lg`, `text-xl` …                                         | `text-base`, `text-title`, `text-headline`                                |
| `font-bold`                                                    | `font-semibold` (títulos) ou `font-medium` (rótulos, botões)              |
| `uppercase tracking-widest`                                    | sentence case, ou `MicroLabel` (`.micro-label`) para o título de um grupo |
| `size={13}`, `size={18}`, `size={24}` num ícone                | `ICON_SM`, `ICON_MD`, `ICON_LG` de `@/lib/icon-sizes`                     |
| `variant="ghost"` no `Button`                                  | `variant="subtle"`                                                        |
| `subtle` com um `text-danger` sobreposto                       | `variant="subtle-danger"`                                                 |
| `<Card variant="solid" \| "glass">`                            | `<Card>` (`padded={false}` mais `className` para outro padding)           |

### Componentes

Peças compartilhadas que substituíram marcação feita por área. Cada uma está documentada em
[`components.md`](./components.md).

- **Novos em `components/ui/`**: `Callout`, `Dialog` (todo modal desenhado à mão migrou para
  ele, e o `ConfirmDialog` é construído sobre ele), `Tabs` (com `TAB_CLASSES` compartilhado
  com o `TabNav`), `Textarea`, `Radio`, `LockedChip`, `ComposerPopover` (movido da feature de
  chat) e `SELECTION_BAR` em `selection-bar.ts`.
- **Alterados em `components/ui/`**: `Button` ganhou `buttonClassName()`, os tamanhos `lg` e
  `icon-sm` e a variante `subtle-danger`, e fica cinza quando desabilitado em vez de esmaecer;
  `Badge` ganhou `info`; `Input` ganhou `hint` e exporta `FIELD_CLASS`; `Spinner` ganhou
  `label`; `TabNav` ganhou `current`; `Toggle` ganhou `ToggleSwitch`; `KbdHint` aceita
  qualquer nó como `keys` (`ReturnKey` desenha ⏎ como ícone) e não é desenhado num ponteiro
  impreciso; `ChipSelect` ganhou `placement`; `ContextRing` ganhou `showValue`; o
  `entityName` do `ConfirmDialog` ficou opcional; o `Toast` passou do canto inferior direito
  para o superior direito; o `Card` perdeu `variant`.
- **Novos em `components/settings/`**: `SettingsPage`, `SettingsSection`, `SettingsRow`,
  `SettingToggle`, `SettingsSegmented`, `SettingsSliderRow`, `SettingsField`,
  `SettingsLoading` e `SettingsLoadError` (`SettingsStates.tsx`), `StatusNote`,
  `PickOneRow`, `CheckboxRow` e `RuleFileRows` (que substituiu o `RuleFileCard`).
- **Novos em `components/layout/`**: `BrandLockup` (sign-in, sign-up, onboarding) e
  `NotFound`.
- **Peças de uma feature que outras features copiam**: `RowList`, `DialogBlocks` e
  `IconButton` (workspace; o painel do GitHub importa `IconButton`), `TurnMetaRow` e
  `ChoiceButton` (chat), `CHAT_COLUMN_CLASS` e `CHAT_GUTTER_X_CLASS`
  (`features/chat/lib/chat-column.ts`), `MEDIA_CONTROL_CLASS` (gallery), `WizardFrame`
  (library).
- **As listas de settings viraram linhas**: `ProviderSettingsCard` → `ProviderSettingsRow`,
  `ConnectorCard` → `ConnectorRow`, `SkillCard` → `SkillRow`, `ToolSettingsCard` →
  `ToolSettingsRow`, cada uma uma linha dentro de um card em vez de um card por item.
- **Textos**: sentence case, a reticência de um caractere só, um nome de produto, mensagens
  com contagem como pares `xOne` / `xOther` escolhidos com `usePlural`, e as chaves mortas
  removidas dos dois dicionários.

### Removido

- `.glass-panel`, `.glass-elevated`, `--glass-*`, `--gradient-primary`.
- O arquivo de fonte da Manrope, o `@font-face` dela e o preload dela.
- `skeleton-shimmer` (uma animação de gradiente), em favor de uma pulsação.
- A paleta de cores do próprio Tailwind, e todo raio, sombra e tamanho de texto que o tema não
  nomeia (`--color-*`, `--radius-*`, `--shadow-*` e `--text-*` partem de `initial`).
- A prop `variant` do `Card`, o nome `ghost` do `Button` e todo `color-mix()` nas folhas de
  estilo.
- Os sete tons derivados `--composer-*` do compositor, `--composer-send-fill` e a faixa de
  status tingida com a cor do runner.

## Regras para código novo

- Procure um componente em [`components.md`](./components.md) antes de escrever as classes
  dele, e adicione uma variante que falta ao componente, não ao ponto de uso.
- Cores são tokens de [`foundations.md`](./foundations.md). Um tom é um token `*-subtle` ou
  `fill-*`, nunca um modificador de opacidade ou um valor arbitrário. Texto sobre uma imagem
  usa a família `scrim-media`.
- Tamanhos vêm das escalas: raios `xs` / `sm` / `md` / `lg` / `full`, tipografia `micro` /
  `xs` / `sm` / `base` / `title` / `headline`, pesos 500 e 600, degraus de espaçamento
  `0.5` / `1` / `1.5` / `2` / `3` / `4` / `5` / `6` / `8` / `12` (nunca `2.5` ou `3.5`),
  ícones em `ICON_SM` / `ICON_MD` / `ICON_LG`.
- Só coisas flutuantes projetam sombra: `shadow-popover` ou `shadow-dialog`.
- Hover e pressionado mudam só a cor: nada de `scale-*`, nada de `transition-all`.
- Mescle classes com `cn()` de `lib/utils.ts`, que conhece os nomes próprios de tipografia e
  de sombra.
- O texto vem de `@mangostudio/shared/i18n`, em `en` e em `pt-BR`, seguindo as regras de
  texto de [`patterns.md`](./patterns.md#textos).

## O teste de conformidade

`apps/frontend/tests/unit/design-system-conformance.test.ts` lê como texto todo arquivo
`.ts`, `.tsx` e `.css` sob `apps/frontend/src` (exceto o gerado `routeTree.gen.ts`), e falha
com uma linha `file:line  offender  ← rule` por ocorrência. Os comentários são removidos
antes, exceto nas três primeiras regras: um comentário que ainda descreve um token aposentado
é documentação desatualizada. As regras marcadas "só código" ignoram as folhas de estilo, que
podem usar numa classe a propriedade que a regra proíbe.

| Regra                                        | Rejeita                                                                                                                                                                                                            | Use no lugar                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Cores da era Material                        | `surface-container`, `on-surface`, `on-primary`, `on-background`, `outline-variant`, `primary-container`, `accent-muted`, `surface-dim`, `--color-primary` e afins, `bg-primary`, `text-error`, `border-outline` … | os tokens da tabela acima                                        |
| Vidro e gradientes                           | `glass-*`, `--glass-`, `backdrop-blur`, `backdrop-filter`, `bg-gradient`, `linear-gradient()` e as outras funções de gradiente, `--gradient-`                                                                      | `surface-raised` + `stroke`, ou um preenchimento sólido          |
| Papéis de fonte aposentados                  | `font-headline`, `font-body`, `font-label`, suas variáveis, Manrope                                                                                                                                                | `font-sans` (o padrão) ou `font-mono`                            |
| Raios                                        | um `rounded` puro, e `rounded-xl` ou maior em qualquer lado ou canto                                                                                                                                               | `rounded-xs`, `-sm`, `-md`, `-lg`, `-full`                       |
| Sombras                                      | um `shadow` puro, `shadow-xs` … `shadow-2xl`, `shadow-inner`, `drop-shadow-*`                                                                                                                                      | `shadow-popover`, `shadow-dialog`, ou nenhuma                    |
| Tamanhos de texto                            | `text-lg` … `text-6xl`, `text-[13px]` e outros tamanhos arbitrários                                                                                                                                                | `text-micro`, `-xs`, `-sm`, `-base`, `-title`, `-headline`       |
| Pesos                                        | `font-bold`, `font-extrabold`, `font-black`, `font-light` e mais leves                                                                                                                                             | `font-medium`, `font-semibold`                                   |
| Caixa e espaçamento entre letras (só código) | `uppercase`, `tracking-wide`, `tracking-wider`, `tracking-widest`                                                                                                                                                  | sentence case, ou `MicroLabel`                                   |
| Tons por opacidade                           | um modificador de opacidade em qualquer cor semântica (`bg-accent/10`, `text-fg/60`)                                                                                                                               | um token `*-subtle` ou `fill-*`                                  |
| Paleta crua                                  | matizes do Tailwind (`bg-amber-500`, `text-blue-400/50`)                                                                                                                                                           | um token                                                         |
| Cores arbitrárias (só código)                | `bg-[#…]`, `[rgb()]`, `[hsl()]`, `[oklch()]`, `[color-mix()]`, `[var(--color-…)]`, `[color:…]` num utilitário de cor                                                                                               | um token                                                         |
| Sobreposições pretas e brancas               | `bg-black`, `bg-white`, `text-white`, `border-black/40` e afins                                                                                                                                                    | `bg-scrim`, ou `bg-scrim-media` e `text-on-scrim-media`          |
| Movimento                                    | `scale-*` (com ou sem `hover:`, `active:`, `focus:`), `transition-all`                                                                                                                                             | uma mudança de cor; `transition-colors`                          |
| Ícones de estado vazio (só código)           | `<EmptyState icon={<Icon size={24} />}>` com um tamanho literal                                                                                                                                                    | `size={ICON_LG}`                                                 |
| Espaçamento fora da grade                    | `2.5` e `3.5` como padding, margin, gap ou `space-*` (`px-2.5`, `-mt-3.5`)                                                                                                                                         | um degrau da grade de 4px; `size-3.5` para uma caixa é permitido |

Um segundo teste falha quando `ALLOWED` cita um arquivo que não existe mais, para que uma
exceção não sobreviva ao código que ela justificava.

As outras verificações (a tabela de tokens em `foundations.md`, contraste, a cascata dos alvos
de toque, `color-mix()` nas folhas de estilo, tokens de movimento e as regras de texto) estão
listadas, com aquilo em que falham, no [README](./README.md#verificação).

## Adicionando uma exceção

Uma exceção é para um uso deliberado para o qual a regra não foi escrita, nunca para uma
classe que só é conveniente.

1. Abra o `ALLOWED` em `design-system-conformance.test.ts`. As chaves são caminhos de arquivo
   relativos a `apps/frontend/src`.
2. Sob o arquivo, adicione a string `why` da regra, copiada exatamente de `RULES` (o teste a
   compara como texto), associada ao seu motivo.
3. Escreva o motivo como o que o elemento é e por que a regra não serve para ele. Uma exceção
   que não sabe dizer o porquê não passa na revisão.

A exceção cobre aquela regra no arquivo inteiro, então restrinja-a ao arquivo que precisa
dela. Existem duas hoje:

- `components/ui/ToolAvatar.tsx` pode usar tamanhos de texto fora da escala e caixa alta: o
  monograma é um glifo dentro de um tile de 16–24px, não texto corrido.
- `components/ui/ContextRing.tsx` pode usar um tamanho de texto fora da escala: a porcentagem
  desenhada dentro do anel de 20px de uma linha da sidebar é um glifo de dado.

## Mudando o vocabulário

Para adicionar, renomear ou aposentar um token: mude o `index.css`, depois a tabela de cores
em [`foundations.md`](./foundations.md) (o `tests/unit/design-tokens-doc.test.ts` lê as linhas
`| Token | Utility | Dark | Light | Use |` da versão em inglês,
[`docs/design/foundations.md`](../../design/foundations.md), e falha quando elas discordam da
folha de estilo), depois a regra de conformidade (`SEMANTIC_COLORS` lista os tokens que a
regra de opacidade conhece), depois o mapeamento de plataforma em
[`native-ports.md`](./native-ports.md), e adicione uma entrada numerada em
[`decisions.md`](./decisions.md).

## Pendências em aberto

- **Severidade do analisador para tools opcionais.** Um achado aparece como neutro ("For
  information") só quando o analisador do runtime o marca com `severity: 'info'`. Um que ele
  deixa sem marcação cai na tabela de códigos do frontend em
  `features/environments/format.ts`, onde `not-found` é uma falha, então uma tool opcional
  ausente ainda pode aparecer como defeito. A correção pertence ao analisador, não ao
  frontend.
- **Proporções reais das imagens.** Os tiles da galeria, seus skeletons e o skeleton de
  imagem sendo gerada reservam um quadrado, porque `GeneratedImageArtifact` não carrega
  dimensões. Desenhar cada imagem na sua própria proporção exige uma mudança de contrato em
  `apps/shared`.
- **Um logo flat.** A marca (`assets/logo.png`) ainda é uma manga ilustrada e sombreada, o
  único recurso não flat ([decisão 1](./decisions.md)). Uma marca flat é uma decisão de marca.
- **Uma convenção para campos opcionais.** Os formulários os marcam de dois jeitos: uma
  legenda `MicroLabel` sobre um grupo (o diálogo de adicionar ambiente) ou "(optional)" num
  rótulo (a descrição do commit, o ID de organização do conector). Escolha um, e decida se
  `Input` e `SettingsField` devem desenhar o marcador por conta própria.
- **Aspas e apóstrofos retos em `en.ts`.** A regra de texto pede `’` e `“…”`, mas dezenove
  strings ainda usam um apóstrofo reto ("destination's"), e cinco citam um nome com `"`
  (`Committed "{subject}"`, `Line numbers for "{path}"`); o `pt-BR.ts` tem as mesmas aspas.
  Outras seis envolvem um comando ou um literal em `"` ("cargo build …", `"mcpServers"`), que
  podem continuar retas. Uma varredura dos dois dicionários, e uma regra em
  `i18n-copy-rules.test.ts` para mantê-la, estão em aberto.
