# Design do MangoStudio

O MangoStudio é uma ferramenta de trabalho: as pessoas passam horas nele conversando com
agentes, lendo diffs e rodando comandos. A interface é **flat, calma e previsível**
(superfícies sólidas, uma cor de destaque, linhas finas) para que as mesmas telas possam ser
redesenhadas em WinUI 3, GTK 4 / libadwaita ou AppKit e ainda pareçam um só produto.

Esta pasta espelha [`docs/design/`](../../design/README.md). Em caso de divergência, vale a
versão em inglês: é ela que os testes leem.

## As páginas, em ordem de leitura

1. [`README.md`](./README.md): esta página. Os princípios, o índice e os testes que fazem
   o sistema valer.
2. [`foundations.md`](./foundations.md): cada token e sua regra. Cor nos dois temas,
   tipografia, espaçamento, alturas de controle, alvos de toque, raio, elevação, estado,
   movimento, ícones e layout.
3. [`components.md`](./components.md): cada componente compartilhado, sua
   anatomia, os tokens que usa e quando recorrer a ele.
4. [`patterns.md`](./patterns.md): como os componentes se combinam em páginas,
   formulários, listas, avisos, diálogos, status e textos.
5. [`decisions.md`](./decisions.md): por que o sistema tem esta forma, uma
   decisão numerada por vez. Uma decisão muda com uma entrada nova, nunca editando uma
   antiga.
6. [`native-ports.md`](./native-ports.md): como cada token e componente se traduz para
   WinUI 3, libadwaita e AppKit (macOS).
7. [`migration.md`](./migration.md): o vocabulário antigo e o novo, como o teste
   de conformidade funciona e como adicionar uma exceção.

## Princípios

1. **Flat antes de profundo.** A hierarquia vem do degrau entre superfícies
   (`canvas` → `surface` → `surface-raised`) e de um `stroke` de 1px. Sem gradientes, sem
   vidro (`backdrop-filter`), sem brilho colorido e sem sombra em nada que não flutue.
2. **Um destaque.** A manga marca a ação principal, o item atual, um controle marcado e o
   foco. Todo o resto é neutro e quente. As cores `agent-*` identificam runners e nada
   mais.
3. **O ritmo da própria plataforma.** Controles de 32px, raio de 6px em tudo que é
   clicável, um cabeçalho de 48px, texto de 14px. São as medidas do WinUI 3 e ficam a um
   ou dois pixels das do libadwaita, então uma build nativa não precisa reescalar nada.
4. **Conforto acima de teatro de contraste.** O texto passa de 4.5:1 nos dois temas; a
   estrutura (bordas, divisores) fica discreta. Nenhum texto abaixo de 11px (o monograma
   de um avatar e o número do anel de contexto são glifos, não texto), e nenhum texto
   esmaecido por opacidade, exceto num controle desabilitado que não diz mais nada.
5. **Terminal como dialeto, não como tema.** A fonte mono aparece onde o conteúdo é
   técnico: chips `key: value`, caminhos, código, saída de tools, rótulos de grupo.
   Títulos, botões e prosa ficam na fonte da interface.

## Como trabalhar com ele

- Escreva a classe a partir de [`foundations.md`](./foundations.md); não invente um valor.
  Se uma tela precisa de algo que o sistema não tem, mude o sistema aqui primeiro e
  explique o motivo em [`decisions.md`](./decisions.md).
- Prefira um componente compartilhado de `apps/frontend/src/components/ui/` a repetir as
  classes dele. [`components.md`](./components.md) lista todos.
- Todo texto visível ao usuário vem de `@mangostudio/shared/i18n`, com só a primeira letra
  maiúscula (sentence case).
- Depois de uma mudança de estilo, rode os testes de verificação abaixo. Eles imprimem
  `file:line` ou o token que quebrou.

## Verificação

Os documentos são um contrato porque estes testes os leem, ou leem o código contra eles:

| Teste                                                        | Em que falha                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/frontend/tests/unit/design-system-conformance.test.ts` | Uma classe fora do vocabulário em qualquer `.ts`, `.tsx` ou `.css` sob `apps/frontend/src`: nomes de cor e de fonte aposentados, vidro e gradientes, raios, sombras e tamanhos de texto fora da escala, pesos bold e light, `uppercase` e espaçamento entre letras largo, tons por opacidade, cores cruas da paleta, valores de cor arbitrários, sobreposições cruas de `black` / `white`, passos de espaçamento de 10px e 14px, `transition-all` e `scale-*`, e um tamanho de ícone literal num `EmptyState`. |
| `apps/frontend/tests/unit/design-tokens-doc.test.ts`         | Um token de cor de `index.css` que falta nas tabelas de [`foundations.md`](../../design/foundations.md) (a versão em inglês), ou um valor diferente em qualquer um dos temas. Ele lê as linhas `\| Token \| Utility \| Dark \| Light \| Use \|`.                                                                                                                                                                                                                                                               |
| `apps/frontend/tests/unit/design-token-contrast.test.ts`     | Texto de status abaixo de 4.5:1 sobre a própria tinta (success e warning sobre `canvas`, `sidebar` e `surface`; danger e info sobre `canvas` e `surface`), `on-scrim-media` abaixo de 4.5:1 sobre `scrim-media` num pixel branco, ou esse par diferindo entre os temas.                                                                                                                                                                                                                                        |
| `apps/frontend/tests/unit/stylesheet-cascade.test.ts`        | Uma regra fora de camada que estiliza um elemento substituído (`img`, `svg`, `video`…) pela tag pura, o piso de 44px para ponteiro impreciso perdendo uma exceção, ou a altura de linha da timeline se afastando dele.                                                                                                                                                                                                                                                                                         |
| `apps/frontend/tests/unit/stylesheet-downlevel.test.ts`      | Um `color-mix()` numa folha de estilo, um espaçamento de densidade da timeline escrito sem unidade, ou `index.css` deixando de compilar com os dois temas e as variáveis de elevação.                                                                                                                                                                                                                                                                                                                          |
| `apps/frontend/tests/unit/lib/motion/tokens.test.ts`         | `lib/motion/tokens.ts` discordando dos tokens de duração e easing de `index.css`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/shared/tests/unit/i18n-copy-rules.test.ts`             | Texto que quebra as regras de [`patterns.md`](./patterns.md): três pontos em vez de `…`, "Mango Studio" em duas palavras, badges de alteração de arquivo em minúscula e chaves que diferem entre `en` e `pt-BR`.                                                                                                                                                                                                                                                                                               |

Rode-os a partir da raiz do repositório:

```sh
bun test apps/frontend/tests/unit/design-system-conformance.test.ts \
  apps/frontend/tests/unit/design-tokens-doc.test.ts \
  apps/frontend/tests/unit/design-token-contrast.test.ts \
  apps/frontend/tests/unit/stylesheet-cascade.test.ts \
  apps/frontend/tests/unit/stylesheet-downlevel.test.ts \
  apps/frontend/tests/unit/lib/motion/tokens.test.ts \
  apps/shared/tests/unit/i18n-copy-rules.test.ts
```

`bun run test` roda todos eles junto com o resto. Uma exceção deliberada ao teste de
conformidade vai no mapa `ALLOWED` dele, com o motivo;
[`migration.md`](./migration.md) explica o processo.

## Onde fica no código

| Assunto                                                       | Arquivo                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Tokens, temas, utilitários, o CSS do compositor e da timeline | `apps/frontend/src/index.css`                                              |
| Tipografia do markdown                                        | `apps/frontend/src/styles/markdown-content.css`                            |
| Componentes compartilhados                                    | `apps/frontend/src/components/ui/`, `apps/frontend/src/components/layout/` |
| Blocos de settings (linhas, seções, segmentos, navegação)     | `apps/frontend/src/components/settings/`                                   |
| A barra do item atual                                         | `apps/frontend/src/components/ui/selection-bar.ts`                         |
| Mesclagem de classes que entende a escala própria             | `apps/frontend/src/lib/utils.ts` (`cn`)                                    |
| Tamanhos de ícone                                             | `apps/frontend/src/lib/icon-sizes.ts`                                      |
| Cores de identidade dos runners (`dotClass`, `colorVar`)      | `apps/frontend/src/lib/agent-identity.ts`                                  |
| A coluna do chat e sua margem lateral                         | `apps/frontend/src/features/chat/lib/chat-column.ts`                       |
| Controles sobre uma imagem (`MEDIA_CONTROL_CLASS`)            | `apps/frontend/src/features/gallery/components/media-control.ts`           |
| Tokens e presets de movimento para animação em JavaScript     | `apps/frontend/src/lib/motion/`                                            |
