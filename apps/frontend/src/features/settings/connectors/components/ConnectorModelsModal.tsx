import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared/catalog';
import type { Connector } from '@mangostudio/shared/connectors';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
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
    <Dialog
      title={s.modelsModalTitle}
      description={
        <>
          {s.modelsModalDescription} <span className="font-medium text-fg">{connector.name}</span>{' '}
          {s.modelsModalDescriptionSuffix}
        </>
      }
      toolbar={
        <Input
          type="text"
          value={modelSearchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={s.searchModelsPlaceholder}
          aria-label={s.searchModelsPlaceholder}
        />
      }
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {s.doneButton}
        </Button>
      }
    >
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
        <EmptyState title={s.noModelsDiscovered} className="min-h-0 py-8" />
      )}
      {(textModels.length > 0 || imageModels.length > 0) &&
        filteredTextModels.length === 0 &&
        filteredImageModels.length === 0 && (
          <EmptyState
            title={t.common.noResultsFor.replace('{query}', () => modelSearchQuery)}
            className="min-h-0 py-8"
          />
        )}
    </Dialog>
  );
}
