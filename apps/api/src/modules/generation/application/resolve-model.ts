import { getUnifiedModelCatalog } from '../../../services/providers/catalog';

export interface ResolveModelInput {
  requestedModel?: string;
  userId: string;
  type: 'text' | 'image';
}

export interface ResolvedModel {
  modelId: string;
}

export class NoModelAvailableError extends Error {
  constructor(type: 'text' | 'image') {
    super(
      type === 'text'
        ? 'No text model available. Configure a connector in Settings.'
        : 'No image model available. Configure a connector in Settings.'
    );
    this.name = 'NoModelAvailableError';
  }
}

export async function resolveModel(input: ResolveModelInput): Promise<ResolvedModel> {
  let modelId = input.requestedModel?.trim() || '';

  if (!modelId) {
    const catalog = await getUnifiedModelCatalog(input.userId);
    modelId =
      input.type === 'text'
        ? (catalog.textModels[0]?.modelId ?? '')
        : (catalog.imageModels[0]?.modelId ?? '');
  }

  if (!modelId) {
    throw new NoModelAvailableError(input.type);
  }

  return { modelId };
}
