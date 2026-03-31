/* global console */
import { useState, useEffect } from 'react';
import type {
  Connector,
  ConnectorStatus,
  ModelCatalogResponse,
  ProviderType,
} from '@mangostudio/shared';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';
import {
  Plus,
  Trash2,
  Settings,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Database,
  FileCode,
  ShieldCheck,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';

interface ConnectorsSettingsProps {
  modelCatalog: ModelCatalogResponse;
  reloadModelCatalog: () => Promise<void>;
}

const PROVIDER_OPTIONS: { id: ProviderType }[] = [
  { id: 'gemini' },
  { id: 'openai' },
  { id: 'openai-compatible' },
  { id: 'anthropic' },
];

/**
 * Connectors settings tab: add, delete, and configure AI connectors for any provider.
 */
export function ConnectorsSettings({ modelCatalog, reloadModelCatalog }: ConnectorsSettingsProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const s = t.settings.connectors;

  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isModelsModalOpen, setIsModelsModalOpen] = useState(false);
  const [selectedConnector, setSelectedConnector] = useState<Connector | null>(null);
  const [connectorToDelete, setConnectorToDelete] = useState<Connector | null>(null);

  const [newConnector, setNewConnector] = useState({
    name: '',
    apiKey: '',
    provider: 'gemini' as ProviderType,
    baseUrl: '',
    source: 'bun-secrets' as Connector['source'],
  });
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  const loadStatus = async () => {
    try {
      const { data, error } = await client.api.settings.connectors.get();
      if (error) throw new Error(extractApiError(error.value, 'Failed to load status.'));
      setConnectorStatus(data as ConnectorStatus);
    } catch (error) {
      console.error('[connectors] Failed to load connector status', error);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const handleAddConnector = async () => {
    if (!newConnector.name.trim() || !newConnector.apiKey.trim()) {
      setFormError(s.errorRequired);
      return;
    }

    if (newConnector.provider === 'openai-compatible' && !newConnector.baseUrl.trim()) {
      setFormError(s.baseUrlRequired);
      return;
    }

    setIsSaving(true);
    setFormError(null);

    try {
      const body: Parameters<typeof client.api.settings.connectors.post>[0] = {
        name: newConnector.name,
        apiKey: newConnector.apiKey,
        source: newConnector.source,
        provider: newConnector.provider,
      };
      if (newConnector.provider === 'openai-compatible' && newConnector.baseUrl.trim()) {
        body.baseUrl = newConnector.baseUrl.trim();
      }

      const { error } = await client.api.settings.connectors.post(body);
      if (error) throw new Error(extractApiError(error.value, 'Failed to add connector'));

      await loadStatus();
      await reloadModelCatalog();
      setIsAddModalOpen(false);
      setNewConnector({
        name: '',
        apiKey: '',
        provider: 'gemini',
        baseUrl: '',
        source: 'bun-secrets',
      });
      toast(s.addSuccess, 'success');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteConnector = async (id: string) => {
    try {
      const { error } = await (client.api.settings.connectors[id] as any).delete();
      if (error) throw new Error(extractApiError(error.value, 'Failed to delete connector'));

      await reloadModelCatalog();
      toast(s.deleteSuccess, 'success');
    } catch (err) {
      console.error(err);
      toast('Failed to delete connector', 'error');
    } finally {
      await loadStatus();
      setConnectorToDelete(null);
    }
  };

  const handleUpdateModels = async (connectorId: string, enabledModels: string[]) => {
    try {
      const { error } = await (client.api.settings.connectors[connectorId] as any).models.put({
        enabledModels,
      });
      if (error) throw new Error(extractApiError(error.value, 'Failed to update models'));

      await loadStatus();
      await reloadModelCatalog();
      toast(s.updateModelsSuccess, 'success');
    } catch (err) {
      console.error(err);
      toast('Failed to update models', 'error');
    }
  };

  const connectors = connectorStatus?.connectors || [];

  // Models for the selected connector's modal: filter catalog by connector provider
  const getDiscoveredModels = (connector: Connector) => {
    const textModels = modelCatalog.discoveredTextModels.filter(
      (m) => !m.provider || m.provider === connector.provider
    );
    const imageModels = modelCatalog.discoveredImageModels.filter(
      (m) => !m.provider || m.provider === connector.provider
    );
    return { textModels, imageModels };
  };

  const SOURCE_OPTIONS = [
    {
      id: 'bun-secrets' as const,
      label: s.sources.bunSecrets,
      icon: <ShieldCheck size={16} />,
      desc: s.sources.bunSecretsDesc,
    },
    {
      id: 'config-file' as const,
      label: s.sources.configFile,
      icon: <FileCode size={16} />,
      desc: s.sources.configFileDesc,
    },
    {
      id: 'environment' as const,
      label: s.sources.envFile,
      icon: <Database size={16} />,
      desc: s.sources.envFileDesc,
    },
  ];

  return (
    <div className="space-y-4">
      <Card variant="solid" className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
            {s.title}
          </h2>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setIsAddModalOpen(true)}
            className="gap-1.5"
          >
            <Plus size={14} />
            {s.addButton}
          </Button>
        </div>

        {connectors.length === 0 ? (
          <div className="bg-surface-container-lowest border border-dashed border-outline-variant/30 rounded-2xl p-8 text-center space-y-4">
            <div className="p-4 bg-surface-container-high rounded-full w-fit mx-auto text-on-surface-variant/40">
              <KeyRound size={32} />
            </div>
            <div className="space-y-1">
              <p className="text-on-surface font-bold">{s.emptyTitle}</p>
              <p className="text-sm text-on-surface-variant/60">{s.emptyDescription}</p>
            </div>
            <Button variant="primary" onClick={() => setIsAddModalOpen(true)}>
              {s.addConnectorButton}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {connectors.map((c) => (
              <div
                key={c.id}
                className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-4 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`p-2.5 rounded-xl ${c.configured ? 'bg-primary/10 text-primary' : 'bg-red-500/10 text-red-300'}`}
                  >
                    {c.configured ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
                  </div>
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-on-surface">{c.name}</h3>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant border border-outline-variant/20">
                        {t.providers[c.provider]}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="flex items-center gap-1 text-on-surface-variant/60">
                        {c.source === 'bun-secrets' && <ShieldCheck size={12} />}
                        {c.source === 'config-file' && <FileCode size={12} />}
                        {c.source === 'environment' && <Database size={12} />}
                        {c.source.replace('-', ' ')}
                      </span>
                      <span className="text-outline-variant">•</span>
                      <span className="font-mono text-on-surface-variant/60">
                        {c.maskedSuffix ?? '****'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedConnector(c);
                      setIsModelsModalOpen(true);
                    }}
                    title={s.configureModels}
                    className="p-2"
                  >
                    <Settings size={18} />
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConnectorToDelete(c)}
                    title={s.deleteConnector}
                    className="p-2 text-red-300 hover:text-red-400 hover:bg-red-500/10"
                  >
                    <Trash2 size={18} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Add Connector Modal ── */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-surface-container-high w-full max-w-md rounded-3xl p-8 shadow-2xl border border-outline-variant/20 space-y-6">
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-on-surface">{s.addModalTitle}</h3>
              <p className="text-sm text-on-surface-variant/70">{s.addModalDescription}</p>
            </div>

            <div className="space-y-4">
              {/* Provider selector */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-on-surface-variant">
                  {s.providerLabel}
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {PROVIDER_OPTIONS.map(({ id }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() =>
                        setNewConnector({
                          ...newConnector,
                          provider: id,
                          baseUrl: id === 'openai-compatible' ? newConnector.baseUrl : '',
                        })
                      }
                      className={`py-2 px-3 rounded-xl border text-xs font-bold text-center transition-all ${
                        newConnector.provider === id
                          ? 'bg-primary/10 border-primary text-primary'
                          : 'bg-surface-container-lowest border-outline-variant/10 text-on-surface hover:border-outline-variant/30'
                      }`}
                    >
                      {t.providers[id]}
                    </button>
                  ))}
                </div>
              </div>

              <Input
                id="connector-name"
                label={s.nameLabel}
                type="text"
                value={newConnector.name}
                onChange={(e) => setNewConnector({ ...newConnector, name: e.target.value })}
                placeholder={s.namePlaceholder}
              />

              {newConnector.provider === 'openai-compatible' && (
                <Input
                  id="connector-baseurl"
                  label={s.baseUrlLabel}
                  type="text"
                  value={newConnector.baseUrl}
                  onChange={(e) => setNewConnector({ ...newConnector, baseUrl: e.target.value })}
                  placeholder={s.baseUrlPlaceholder}
                />
              )}

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="connector-apikey"
                  className="text-sm font-medium text-on-surface-variant"
                >
                  {s.apiKeyLabel}
                </label>
                <div className="flex gap-2">
                  <input
                    id="connector-apikey"
                    type={showKey ? 'text' : 'password'}
                    value={newConnector.apiKey}
                    onChange={(e) => setNewConnector({ ...newConnector, apiKey: e.target.value })}
                    className="
                      flex-1 rounded-xl px-4 py-2.5 text-sm
                      bg-surface-container-high text-on-surface
                      border border-outline-variant/20
                      placeholder:text-on-surface/30
                      focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20
                      transition-colors
                    "
                    placeholder={s.apiKeyPlaceholder}
                  />
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => setShowKey(!showKey)}
                    className="px-3"
                    type="button"
                  >
                    {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-xs font-bold text-on-surface-variant uppercase ml-1">
                  {s.saveToLabel}
                </label>
                <div className="grid grid-cols-1 gap-2">
                  {SOURCE_OPTIONS.map((src) => (
                    <button
                      key={src.id}
                      type="button"
                      onClick={() => setNewConnector({ ...newConnector, source: src.id })}
                      className={`flex items-start gap-4 p-4 rounded-2xl border text-left transition-all ${
                        newConnector.source === src.id
                          ? 'bg-primary/10 border-primary text-primary'
                          : 'bg-surface-container-lowest border-outline-variant/10 text-on-surface hover:border-outline-variant/30'
                      }`}
                    >
                      <div className="mt-1">{src.icon}</div>
                      <div className="space-y-0.5">
                        <div className="text-sm font-bold">{src.label}</div>
                        <div
                          className={`text-[10px] ${newConnector.source === src.id ? 'text-primary/70' : 'text-on-surface-variant/60'}`}
                        >
                          {src.desc}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {formError && (
              <p className="text-xs text-red-400 font-medium text-center">{formError}</p>
            )}

            <div className="flex gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  setIsAddModalOpen(false);
                  setFormError(null);
                }}
                className="flex-1"
              >
                {s.cancelButton}
              </Button>
              <Button
                variant="primary"
                onClick={handleAddConnector}
                loading={isSaving}
                disabled={isSaving}
                className="flex-1"
              >
                {isSaving ? (
                  <>
                    <LoaderCircle size={16} className="animate-spin" />
                    {s.validating}
                  </>
                ) : (
                  s.addConnectorButton
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Models Selection Modal ── */}
      {isModelsModalOpen &&
        selectedConnector &&
        (() => {
          const { textModels, imageModels } = getDiscoveredModels(selectedConnector);
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
              <div className="bg-surface-container-high w-full max-w-lg rounded-3xl p-8 shadow-2xl border border-outline-variant/20 flex flex-col max-h-[80vh]">
                <div className="space-y-2 mb-6">
                  <h3 className="text-xl font-bold text-on-surface">{s.modelsModalTitle}</h3>
                  <p className="text-sm text-on-surface-variant/70">
                    {s.modelsModalDescription}{' '}
                    <span className="text-primary font-bold">{selectedConnector.name}</span>{' '}
                    {s.modelsModalDescriptionSuffix}
                  </p>
                </div>

                <div className="flex-1 overflow-y-auto pr-2 space-y-6 hide-scrollbar">
                  {textModels.length > 0 && (
                    <div className="space-y-3">
                      <h4 className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant/60">
                        {s.textModelsLabel}
                      </h4>
                      <div className="grid grid-cols-1 gap-2">
                        {textModels.map((m) => {
                          const isEnabled = selectedConnector.enabledModels.includes(m.modelId);
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
                                  const next = e.target.checked
                                    ? [...selectedConnector.enabledModels, m.modelId]
                                    : selectedConnector.enabledModels.filter(
                                        (id) => id !== m.modelId
                                      );
                                  const updated = { ...selectedConnector, enabledModels: next };
                                  setSelectedConnector(updated);
                                  void handleUpdateModels(selectedConnector.id, next);
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

                  {imageModels.length > 0 && (
                    <div className="space-y-3">
                      <h4 className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant/60">
                        {s.imageModelsLabel}
                      </h4>
                      <div className="grid grid-cols-1 gap-2">
                        {imageModels.map((m) => {
                          const isEnabled = selectedConnector.enabledModels.includes(m.modelId);
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
                                  const next = e.target.checked
                                    ? [...selectedConnector.enabledModels, m.modelId]
                                    : selectedConnector.enabledModels.filter(
                                        (id) => id !== m.modelId
                                      );
                                  const updated = { ...selectedConnector, enabledModels: next };
                                  setSelectedConnector(updated);
                                  void handleUpdateModels(selectedConnector.id, next);
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
                </div>

                <Button
                  variant="primary"
                  onClick={() => setIsModelsModalOpen(false)}
                  className="mt-8 w-full py-4"
                >
                  {s.doneButton}
                </Button>
              </div>
            </div>
          );
        })()}

      {/* ── Confirm Delete Modal ── */}
      {connectorToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-surface-container-high w-full max-w-sm rounded-3xl p-8 shadow-2xl border border-outline-variant/20 space-y-6">
            <div className="space-y-2 text-center">
              <div className="p-4 bg-red-500/10 rounded-full w-fit mx-auto text-red-400 mb-2">
                <Trash2 size={32} />
              </div>
              <h3 className="text-xl font-bold text-on-surface">{s.deleteConnector}</h3>
              <p className="text-sm text-on-surface-variant/70">
                {s.deleteConfirm} <br />
                <span className="text-on-surface font-bold">"{connectorToDelete.name}"</span>
              </p>
            </div>

            <div className="flex gap-3">
              <Button
                variant="secondary"
                onClick={() => setConnectorToDelete(null)}
                className="flex-1"
              >
                {s.cancelButton}
              </Button>
              <Button
                variant="primary"
                onClick={() => handleDeleteConnector(connectorToDelete.id)}
                className="flex-1 bg-red-500 hover:bg-red-400 shadow-red-500/20"
              >
                {s.deleteConnector}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
