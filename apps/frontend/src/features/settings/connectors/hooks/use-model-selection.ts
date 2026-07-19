/**
 * Hook: model enable/disable state, search/filter, and save.
 */

import type { Connector, ModelCatalogResponse } from '@mangostudio/shared';
import { useRef, useState } from 'react';
import { updateConnectorModels } from '../api';

function withModelToggled(enabledModels: string[], modelId: string, checked: boolean): string[] {
  return checked
    ? enabledModels.includes(modelId)
      ? enabledModels
      : [...enabledModels, modelId]
    : enabledModels.filter((id) => id !== modelId);
}

export function useModelSelection(
  modelCatalog: ModelCatalogResponse,
  reloadConnectors: () => Promise<void>,
  reloadModelCatalog: () => Promise<void>,
  onToggleError: (err: unknown) => void
) {
  const [selectedConnector, setSelectedConnector] = useState<Connector | null>(null);
  // Mirrors selectedConnector so overlapping toggles read the latest value instead of a
  // stale render closure. Every mutation goes through setConnector to keep the two in sync.
  const selectedConnectorRef = useRef(selectedConnector);
  const setConnector = (value: Connector | null) => {
    selectedConnectorRef.current = value;
    setSelectedConnector(value);
  };
  const [modelSearchQuery, setModelSearchQuery] = useState('');

  const openModals = (connector: Connector) => {
    setConnector(connector);
    setModelSearchQuery('');
  };

  const closeModal = () => setConnector(null);

  const getDiscoveredModels = (connector: Connector) => {
    const textModels = modelCatalog.discoveredTextModels.filter(
      (m) => !m.provider || m.provider === connector.provider
    );
    const imageModels = modelCatalog.discoveredImageModels.filter(
      (m) => !m.provider || m.provider === connector.provider
    );
    return { textModels, imageModels };
  };

  const handleToggleModel = async (modelId: string, checked: boolean) => {
    const current = selectedConnectorRef.current;
    if (!current) return;
    const connectorId = current.id;
    const next = withModelToggled(current.enabledModels, modelId, checked);
    setConnector({ ...current, enabledModels: next });

    try {
      await updateConnectorModels(connectorId, next);
    } catch (err) {
      // Undo only this toggle; concurrent toggles that already landed stay applied.
      const pending = selectedConnectorRef.current;
      if (pending && pending.id === connectorId) {
        setConnector({
          ...pending,
          enabledModels: withModelToggled(pending.enabledModels, modelId, !checked),
        });
      }
      onToggleError(err);
      return;
    }

    // The write persisted, so a refresh failure must surface without reverting the toggle.
    try {
      await reloadConnectors();
      await reloadModelCatalog();
    } catch (err) {
      onToggleError(err);
    }
  };

  return {
    selectedConnector,
    modelSearchQuery,
    setModelSearchQuery,
    openModals,
    closeModal,
    getDiscoveredModels,
    handleToggleModel,
  };
}
