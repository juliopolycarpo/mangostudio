/* global console */
import { useState } from 'react';
import type { Connector, ModelCatalogResponse } from '@mangostudio/shared';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { deleteConnector } from './api';
import { useConnectors } from './hooks/use-connectors';
import { useConnectorForm } from './hooks/use-connector-form';
import { useModelSelection } from './hooks/use-model-selection';
import { ConnectorList } from './components/ConnectorList';
import { AddConnectorModal } from './components/AddConnectorModal';
import { ConnectorModelsModal } from './components/ConnectorModelsModal';
import { DeleteConfirmDialog } from './components/DeleteConfirmDialog';

interface ConnectorsSettingsProps {
  modelCatalog: ModelCatalogResponse;
  reloadModelCatalog: () => Promise<void>;
}

function isReadOnlySharedConnector(connector: Connector): boolean {
  return (
    connector.userId === null &&
    connector.source !== 'config-file' &&
    connector.source !== 'environment'
  );
}

export function ConnectorsSettings({ modelCatalog, reloadModelCatalog }: ConnectorsSettingsProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const s = t.settings.connectors;

  const { connectors, reload: reloadConnectors } = useConnectors();
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [connectorToDelete, setConnectorToDelete] = useState<Connector | null>(null);

  const connectorForm = useConnectorForm({
    errorRequired: s.errorRequired,
    baseUrlRequired: s.baseUrlRequired,
    onSuccess: async () => {
      setIsAddModalOpen(false);
      toast(s.addSuccess, 'success');
      await reloadConnectors();
      await reloadModelCatalog();
    },
  });

  const modelSelection = useModelSelection(modelCatalog, reloadConnectors, reloadModelCatalog);

  const handleDeleteConnector = async (id: string) => {
    const connector = connectors.find((c) => c.id === id);
    if (connector && isReadOnlySharedConnector(connector)) {
      toast(s.sharedDeleteBlocked, 'error');
      setConnectorToDelete(null);
      return;
    }

    try {
      await deleteConnector(id);
      await reloadModelCatalog();
      toast(s.deleteSuccess, 'success');
    } catch (err) {
      console.error(err);
      toast('Failed to delete connector', 'error');
    } finally {
      await reloadConnectors();
      setConnectorToDelete(null);
    }
  };

  return (
    <div className="space-y-4">
      <ConnectorList
        connectors={connectors}
        onAddConnector={() => setIsAddModalOpen(true)}
        onConfigureConnector={modelSelection.openModals}
        onDeleteConnector={(c) => {
          if (isReadOnlySharedConnector(c)) {
            toast(s.sharedDeleteBlocked, 'error');
            return;
          }
          setConnectorToDelete(c);
        }}
      />

      {isAddModalOpen && (
        <AddConnectorModal
          form={connectorForm.form}
          setForm={connectorForm.setForm}
          isSaving={connectorForm.isSaving}
          formError={connectorForm.formError}
          showKey={connectorForm.showKey}
          setShowKey={connectorForm.setShowKey}
          onSubmit={() => void connectorForm.submit()}
          onClose={() => {
            setIsAddModalOpen(false);
            connectorForm.reset();
          }}
        />
      )}

      {modelSelection.selectedConnector && (
        <ConnectorModelsModal
          connector={modelSelection.selectedConnector}
          modelCatalog={modelCatalog}
          modelSearchQuery={modelSelection.modelSearchQuery}
          onSearchChange={modelSelection.setModelSearchQuery}
          onToggleModel={modelSelection.handleToggleModel}
          onClose={modelSelection.closeModal}
        />
      )}

      {connectorToDelete && (
        <DeleteConfirmDialog
          connector={connectorToDelete}
          onConfirm={() => void handleDeleteConnector(connectorToDelete.id)}
          onCancel={() => setConnectorToDelete(null)}
        />
      )}
    </div>
  );
}
