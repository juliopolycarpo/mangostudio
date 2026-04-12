import type { Connector, ModelCatalogResponse } from '@mangostudio/shared';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';

interface ConnectorModelsModalProps {
  connector: Connector;
  modelCatalog: ModelCatalogResponse;
  modelSearchQuery: string;
  onSearchChange: (query: string) => void;
  onToggleModel: (modelId: string, checked: boolean) => void | Promise<void>;
  onClose: () => void;
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

  const textModels = modelCatalog.discoveredTextModels.filter(
    (m) => !m.provider || m.provider === connector.provider
  );
  const imageModels = modelCatalog.discoveredImageModels.filter(
    (m) => !m.provider || m.provider === connector.provider
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-container-high w-full max-w-lg rounded-3xl p-8 shadow-2xl border border-outline-variant/20 flex flex-col max-h-[80vh]">
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
          {filteredTextModels.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant/60">
                {s.textModelsLabel}
              </h4>
              <div className="grid grid-cols-1 gap-2">
                {filteredTextModels.map((m) => {
                  const isEnabled = connector.enabledModels.includes(m.modelId);
                  return (
                    <label
                      key={m.modelId}
                      className={`flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-all ${
                        isEnabled
                          ? 'bg-primary/10 border-primary/30'
                          : 'bg-surface-container-lowest border-outline-variant/10 hover:border-outline-variant/30'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={(e) => {
                          void onToggleModel(m.modelId, e.target.checked);
                        }}
                        className="w-5 h-5 rounded border-outline-variant text-primary focus:ring-primary bg-surface-container-lowest"
                      />
                      <div className="space-y-0.5">
                        <div
                          className={`text-sm font-bold ${isEnabled ? 'text-primary' : 'text-on-surface'}`}
                        >
                          {m.displayName}
                        </div>
                        <div className="text-[10px] font-mono text-on-surface-variant/60">
                          {m.modelId}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {filteredImageModels.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant/60">
                {s.imageModelsLabel}
              </h4>
              <div className="grid grid-cols-1 gap-2">
                {filteredImageModels.map((m) => {
                  const isEnabled = connector.enabledModels.includes(m.modelId);
                  return (
                    <label
                      key={m.modelId}
                      className={`flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-all ${
                        isEnabled
                          ? 'bg-primary/10 border-primary/30'
                          : 'bg-surface-container-lowest border-outline-variant/10 hover:border-outline-variant/30'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={(e) => {
                          void onToggleModel(m.modelId, e.target.checked);
                        }}
                        className="w-5 h-5 rounded border-outline-variant text-primary focus:ring-primary bg-surface-container-lowest"
                      />
                      <div className="space-y-0.5">
                        <div
                          className={`text-sm font-bold ${isEnabled ? 'text-primary' : 'text-on-surface'}`}
                        >
                          {m.displayName}
                        </div>
                        <div className="text-[10px] font-mono text-on-surface-variant/60">
                          {m.modelId}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {textModels.length === 0 && imageModels.length === 0 && (
            <div className="rounded-2xl border border-dashed border-outline-variant/20 bg-surface-container-lowest px-4 py-8 text-center text-sm text-on-surface-variant/70">
              {s.noModelsDiscovered}
            </div>
          )}
          {(textModels.length > 0 || imageModels.length > 0) &&
            filteredTextModels.length === 0 &&
            filteredImageModels.length === 0 && (
              <div className="rounded-2xl border border-dashed border-outline-variant/20 bg-surface-container-lowest px-4 py-8 text-center text-sm text-on-surface-variant/70">
                No results for &quot;{modelSearchQuery}&quot;
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
