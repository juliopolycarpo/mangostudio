# Geração De Imagem

O MangoStudio suporta geração de imagem por dois caminhos: a tool `generate_image`, chamada por modelos durante chats de texto, e a geração direta iniciada pela UI.

## Arquitetura

```
Frontend (GalleryPage, useImageGeneration)
    │
    ▼
Rotas da API
    ├─ POST /api/generate        → Geração direta de imagem
    ├─ GET  /images/:filename      → Servir imagens geradas
    └─ Durante turnos de chat      → Execução da tool generate_image
         │
         ▼
Serviço de geração (generate-image.ts)
    ├─ Resolução de modelo (type: 'image')
    ├─ Geração de imagem pelo provedor
    │
    ▼
Storage (generated-image-storage.ts)
    ├─ Escrita de arquivos no diretório de imagens
    └─ Geração do path de URL
         │
         ▼
Repository (generated-image-repository.ts)
    ├─ Insere linha de artefato
    ├─ Consulta por IDs de mensagem
    └─ Paginação da galeria
```

## Fluxos De Geração De Imagem

### 1. Geração baseada em tool (durante o chat)

Quando a tool `generate_image` é invocada em um turno de chat de texto:

1. **Detecção da tool** — `stream-text-turn.ts` detecta a tool call `generate_image`.
2. **Tools padrão primeiro** — Tools não relacionadas a imagem são executadas em paralelo com `Promise.all`.
3. **Planejamento da imagem** — `createGenerateImageToolPlan()` interpreta os argumentos do LLM, como prompt, quantidade, qualidade e modelo, junto com as configurações do usuário.
4. **Streaming por imagem** — `generateImagesForToolPlan()` produz resultados por imagem:
   - evento SSE `image_generation_started` para cada imagem planejada
   - `image_generation_completed` em caso de sucesso, com URL e metadados
   - `image_generation_failed` em caso de falha, com detalhes do erro
5. **Resumo do resultado** — `summarizeGenerateImageToolResult()` colapsa os resultados em um único tool result devolvido ao modelo.
6. **Persistência** — `insertGeneratedImageArtifact()` armazena os metadados de cada imagem na tabela `generated_images`.
7. **Renderização na UI** — O componente `GeneratedImagePart` no feed do chat renderiza as imagens concluídas.

### 2. Geração direta (iniciada pela UI)

Quando o usuário clica em "Generate Image" diretamente:

1. **Rota** — `POST /api/generate` com `chatId` e `prompt` obrigatórios; `model`, `imageQuality`, `referenceImageUrl`, `systemPrompt` e `promptSettings` opcionais (`GenerateImageBodySchema`).
2. **Composição do prompt** — System prompt rules são aplicadas via `prompt-composer.ts`.
3. **Chamada ao provedor** — `provider.generateImage()` lida com a API específica do provedor.
4. **Persistência do turno** — `persistImageTurn()` cria mensagem do usuário + resposta da IA + artefatos de imagem em uma única transação.
5. **Resposta** — Retorna `GenerateImageResult` com as duas mensagens para renderização imediata.

## Seleção De Modelo

Escolha os modelos de imagem oferecidos pelo catálogo do conector configurado. Uma entrada não prova disponibilidade atual do fornecedor ou geração bem-sucedida: confirme o ciclo de vida e a compatibilidade do adapter. Este guia não recomenda um ID fixo.

A classificação usa padrões de ID em [`isImageModelId`](../../../apps/shared/src/utils/model-detection.ts) (prefixos de famílias de imagem e padrões `-image`), não uma flag de capacidade `imageGeneration`. O seletor filtra pelo tipo de modelo resultante. Consulte o helper atual ao adicionar uma família.

## Storage De Imagens Geradas

As imagens são armazenadas no sistema de arquivos sob o diretório configurado em `images.dir`, cujo padrão é `~/.mango/images/`.

**Padrão de nome do arquivo:** `{prefix}-{timestamp}-{uuid}.{ext}`

**Formatos suportados:** AVIF, GIF, JPEG, PNG, WebP

**Acesso por URL:** imagens são servidas por `GET /images/:filename`. A API mapeia essa rota para servir arquivos estáticos do diretório de imagens.

## Galeria

A galeria em `apps/frontend/src/features/gallery/GalleryPage.tsx` oferece:

- **Infinite scroll** — paginação por cursor com `IntersectionObserver`
- **Grid responsivo** — de 1 a 4 colunas, dependendo da largura da viewport
- **Cards de imagem** — imagens lazy-loaded com overlay gradiente ao passar o mouse, exibindo o prompt
- **Modal view** — clique para ampliar, com opção de download
- **Filtragem** — consultas por `userId`, ordenadas por data de criação decrescente

### Query Da Galeria

```typescript
listGeneratedImagesForGallery(userId, { cursor, limit }, db);
// Retorna: GalleryEntry<GalleryItem>[] — até limit + 1 entradas, cada uma { item, source: 'artifact', rowid }
```

O repositório retorna entradas brutas, não uma página. O `listGalleryUseCase` as mescla com as mensagens de imagem legadas sob uma única ordem total (`createdAt` decrescente, depois a origem, depois `rowid` decrescente), corta em `limit` e monta a página `{ items, nextCursor }`. O cursor é `<artifact|message>:<createdAt>:<rowid>`; um timestamp numérico puro de um servidor antigo ainda é aceito, e um cursor vazio ou malformado é rejeitado com 400.

## Imagens Geradas Vs Uploads

| Aspecto                     | Imagens geradas           | Uploads (Attachments) |
| --------------------------- | ------------------------- | --------------------- |
| **Origem**                  | Criadas por modelos de IA | Enviadas por usuários |
| **Path de storage**         | `images.dir/`             | `uploads.dir/`        |
| **Tabela no DB**            | `generated_images`        | `chat_attachments`    |
| **Prefixo da URL**          | `/images/`                | `/uploads/`           |
| **Galeria**                 | Sim                       | Não                   |
| **Entrega como attachment** | Não                       | Sim                   |
