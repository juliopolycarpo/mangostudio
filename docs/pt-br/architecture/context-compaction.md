# Compactação De Contexto

Quando uma conversa se aproxima do limite da janela de contexto do modelo, o MangoStudio avisa o usuário e oferece opções de compactação. Este documento explica o sistema de snapshots, os limiares de severidade e os fluxos de compactação.

## Snapshot De Contexto

Depois de cada turno, o orquestrador calcula um `ContextSnapshot`:

```typescript
interface ContextSnapshot {
  estimatedInputTokens: number;
  contextLimit: number; // máximo de tokens de entrada do modelo
  estimatedUsageRatio: number; // fração de 0–1 do contexto consumido
  providerReportedTokens?: number;
  severity: ContextSeverity;
}
```

### Estimativa

- Caracteres são convertidos em tokens usando uma estimativa de aproximadamente 4 caracteres por token.
- Quando o provedor informa o uso real de tokens de entrada, esse valor tem prioridade sobre a estimativa.
- O snapshot inclui: tamanho do system prompt + texto do histórico + definições de tools + contagem de caracteres local ao turno.

### Persistência

O snapshot é serializado em `chats.lastContextState` como um blob JSON após cada turno. O frontend o lê para exibir o context ring e os avisos.

## Limiares De Severidade

| Razão  | Severidade | Ação                                  |
| ------ | ---------- | ------------------------------------- |
| 0–69%  | `normal`   | Sem aviso                             |
| 70–84% | `info`     | Indicador sutil                       |
| 85–91% | `warning`  | Anel amarelo + callout opcional       |
| 92–96% | `danger`   | Anel laranja + callout de compactação |
| 97%+   | `critical` | Anel vermelho + callout imediato      |

Os limiares são definidos em `context-policy.ts`.

## Context Ring

O componente `ContextRing` na sidebar exibe um indicador circular SVG de progresso:

- **Tamanho:** 20×20px
- **Cores:** Verde (`normal`) → Amarelo (`warning`) → Laranja (`danger`) → Vermelho (`critical`)
- **Arco:** Mostra a razão de uso como um anel parcialmente preenchido.
- **Número:** Percentual exibido no centro com fonte de 7px.

## Callout De Compactação

Quando a severidade chega a `warning` ou acima, o `ContextWarningCallout` aparece no feed do chat acima da barra de input com três ações:

1. **Compactar e continuar** — Resume o histórico do chat atual, limpa o estado do provedor e continua no mesmo chat.
2. **Iniciar chat resumido** — Cria um novo chat com um resumo da conversa atual como contexto.
3. **Continuar assim mesmo** — Dispensa o aviso e prossegue sem compactação.

### `compactChatUseCase`

1. Carrega o histórico completo de mensagens.
2. Formata como pares `User: ... / Assistant: ...`.
3. Chama um modelo dedicado de sumarização com um system prompt fixo.
4. Persiste o resumo como um par de mensagens `system_event` + `text`.
5. Limpa `chats.lastProviderState`, forçando replay no próximo turno.
6. Atualiza `chats.lastContextState` com modo `compacted`.

### `summarizeToNewChatUseCase`

1. Cria um novo chat com o mesmo título e a mesma configuração de modelo.
2. Resume o histórico do chat de origem.
3. Persiste o resumo como um evento `summary_handoff` no novo chat.
4. O novo chat começa com uma janela de contexto limpa.

## Compactação No Lado Do Provedor

Provedores stateful como OpenAI e Gemini suportam compactação no servidor:

- **OpenAI** — parâmetro `context_management` com `compact_threshold`. A conversa é compactada automaticamente no servidor quando o limiar é atingido.
- **Gemini** — compactação de interações embutida e tratada de forma transparente pela API.

A compactação no lado do provedor é habilitada por padrão e pode ser desativada por request via `contextSettings.providerCompactionEnabled`.

## Funções Da Política De Contexto

`context-policy.ts` fornece:

| Função                                | Finalidade                                      |
| ------------------------------------- | ----------------------------------------------- |
| `getModelContextLimit(modelName)`     | Retorna o máximo de tokens de entrada do modelo |
| `computeContextSnapshot(...)`         | Estima uso de tokens e severidade               |
| `getContextSeverity(ratio)`           | Mapeia a razão para a faixa de severidade       |
| `recommendContextAction(ratio, mode)` | Sugere a ação de compactação                    |
| `estimateTokenCount(text)`            | Conversão aproximada de caracteres para tokens  |

### Limites De Contexto Dos Modelos

Uma tabela curada cobre mais de 120 variantes de modelo. Prioridade de lookup:

1. Match exato pelo nome do modelo.
2. Match pelo prefixo mais longo.
3. Heurística legada, como `gpt-4` → 128k e `gemini-1.5` → 1M.
4. Fallback: 128.000 tokens.

## Configurações De Contexto (Configuráveis Pelo Usuário)

Usuários podem configurar o comportamento de compactação em Settings → Context:

| Configuração                | Padrão                | Finalidade                                    |
| --------------------------- | --------------------- | --------------------------------------------- |
| `compactionEnabled`         | `true`                | Habilita/desabilita o callout de compactação  |
| `compactionThreshold`       | 85                    | Percentual a partir do qual o callout aparece |
| `compactionSummaryModelId`  | (default do provedor) | Modelo usado para sumarização                 |
| `providerCompactionEnabled` | `true`                | Habilita compactação no lado do provedor      |
