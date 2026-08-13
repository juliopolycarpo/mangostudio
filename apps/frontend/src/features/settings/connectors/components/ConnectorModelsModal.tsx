import type { Connector, ModelCatalogResponse, ModelOption } from '@mangostudio/shared';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { ModelToggleList } from './ModelToggleList';

interface ConnectorModelsModalProps {
  connector: Connector;
  modelCatalog: ModelCatalogResponse;
  modelSearchQuery: string;
  onSearchChange: (query: string) => void;
  onToggleModel: (modelId: string, checked: boolean) => void | Promise<void>;
  onClose: () => void;
}

function tombstoneOption(modelId: string, provider: Connector['provider']): ModelOption {
  return {
    modelId,
    resourceName: modelId,
    displayName: modelId,
    supportedActions: [],
    provider,
    capabilities: { text: true, image: false, streaming: false },
  };
}

/**
 * Discovered models for this connector, plus any enabled ids the catalog no
 * longer lists. Deprecated providers advertise nothing, so without the
 * tombstones the editor would claim the connector has no models at all.
 */
function modelsForConnector(
  discoveredText: ModelOption[],
  discoveredImage: ModelOption[],
  connector: Connector
): { textModels: ModelOption[]; imageModels: ModelOption[] } {
  const known = new Set([...discoveredText, ...discoveredImage].map((model) => model.modelId));
  const tombs = connector.enabledModels
    .filter((modelId) => !known.has(modelId))
    .map((modelId) => tombstoneOption(modelId, connector.provider));
  return { textModels: [...discoveredText, ...tombs], imageModels: discoveredImage };
}

export function ConnectorModelsModal({
  connector,
  modelCatalog,
  modelSearchQuery,
  onSearchChange,
  onToggleModel,
  onClose,
}: ConnectorModelsModalProps) {
  const { t } = useI18n();
  const s = t.settings.connectors;

  const discoveredText = modelCatalog.discoveredTextModels.filter(
    (m) => !m.provider || m.provider === connector.provider
  );
  const discoveredImage = modelCatalog.discoveredImageModels.filter(
    (m) => !m.provider || m.provider === connector.provider
  );
  const { textModels, imageModels } = modelsForConnector(
    discoveredText,
    discoveredImage,
    connector
  );

  const query = modelSearchQuery.toLowerCase().trim();
  const filterByQuery = (models: typeof textModels) =>
    query
      ? models.filter(
          (m) =>
            m.displayName.toLowerCase().includes(query) || m.modelId.toLowerCase().includes(query)
        )
      : models;

  const filteredTextModels = filterByQuery(textModels);
  const filteredImageModels = filterByQuery(imageModels);
  const enabledModelIds = new Set(connector.enabledModels);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-container-high w-full max-w-lg rounded-3xl p-5 sm:p-8 shadow-2xl border border-outline-variant/20 flex flex-col max-h-[90vh] sm:max-h-[80vh]">
        <div className="space-y-2 mb-6">
          <h3 className="text-xl font-bold text-on-surface">{s.modelsModalTitle}</h3>
          <p className="text-sm text-on-surface-variant/70">
            {s.modelsModalDescription}{' '}
            <span className="text-primary font-bold">{connector.name}</span>{' '}
            {s.modelsModalDescriptionSuffix}
          </p>
        </div>

        <div className="relative mb-4">
          <input
            type="text"
            value={modelSearchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={s.searchModelsPlaceholder}
            className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-4 py-3 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </div>

        <div className="flex-1 overflow-y-auto pr-2 space-y-6 hide-scrollbar">
          <ModelToggleList
            title={s.textModelsLabel}
            models={filteredTextModels}
            enabledModelIds={enabledModelIds}
            onToggleModel={onToggleModel}
          />

          <ModelToggleList
            title={s.imageModelsLabel}
            models={filteredImageModels}
            enabledModelIds={enabledModelIds}
            onToggleModel={onToggleModel}
          />

          {textModels.length === 0 && imageModels.length === 0 && (
            <div className="rounded-2xl border border-dashed border-outline-variant/20 bg-surface-container-lowest px-4 py-8 text-center text-sm text-on-surface-variant/70">
              {s.noModelsDiscovered}
            </div>
          )}
          {(textModels.length > 0 || imageModels.length > 0) &&
            filteredTextModels.length === 0 &&
            filteredImageModels.length === 0 && (
              <div className="rounded-2xl border border-dashed border-outline-variant/20 bg-surface-container-lowest px-4 py-8 text-center text-sm text-on-surface-variant/70">
                {t.common.noResultsFor.replace('{query}', () => modelSearchQuery)}
              </div>
            )}
        </div>

        <Button variant="primary" onClick={onClose} className="mt-8 w-full py-4">
          {s.doneButton}
        </Button>
      </div>
    </div>
  );
}
