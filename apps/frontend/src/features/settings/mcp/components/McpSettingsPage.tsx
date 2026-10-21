/**
 * MCP settings page: server list with live-ish status, add/edit form modal,
 * and delete confirmation.
 */

import type { McpServer } from '@mangostudio/shared/mcp';
import { FileDown, FileUp, Plus, Server } from 'lucide-react';
import { useState } from 'react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsLoadError, SettingsLoading } from '@/components/settings/SettingsStates';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  useAddMcpServer,
  useDeleteMcpServer,
  useMcpServers,
  useUpdateMcpServer,
} from '../hooks/use-mcp-servers';
import { buildAddBody, buildUpdateBody, type McpServerFormState } from '../lib/server-form';
import { ExportServersDialog } from './ExportServersDialog';
import { ImportServersDialog } from './ImportServersDialog';
import { McpServerCard } from './McpServerCard';
import { McpServerForm } from './McpServerForm';

type FormMode = { kind: 'add' } | { kind: 'edit'; server: McpServer };

export function McpSettingsPage() {
  const { t } = useI18n();
  const s = t.settings.mcp;
  const { toast } = useToast();

  const { servers, isLoading, error, refetch } = useMcpServers();
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [serverToDelete, setServerToDelete] = useState<McpServer | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const addMutation = useAddMcpServer();
  const updateMutation = useUpdateMcpServer();
  const deleteMutation = useDeleteMcpServer();

  const closeForm = () => {
    setFormMode(null);
    setSubmitError(null);
  };

  const handleSubmit = (state: McpServerFormState) => {
    if (!formMode) return;
    setSubmitError(null);

    if (formMode.kind === 'add') {
      addMutation.mutate(buildAddBody(state), {
        onSuccess: () => {
          closeForm();
          toast(s.addSuccess, 'success');
        },
        onError: (err) => setSubmitError(resolveApiErrorMessage(err, s.failedToAdd)),
      });
      return;
    }

    updateMutation.mutate(
      { id: formMode.server.id, body: buildUpdateBody(state) },
      {
        onSuccess: () => {
          closeForm();
          toast(s.updateSuccess, 'success');
        },
        onError: (err) => setSubmitError(resolveApiErrorMessage(err, s.failedToUpdate)),
      }
    );
  };

  const handleDelete = (server: McpServer) => {
    deleteMutation.mutate(server.id, {
      onSuccess: () => toast(s.deleteSuccess, 'success'),
      onError: (err) => toast(resolveApiErrorMessage(err, s.failedToDelete), 'error'),
      onSettled: () => setServerToDelete(null),
    });
  };

  return (
    <SettingsPage
      title={s.title}
      description={s.description}
      actions={
        isLoading || error ? undefined : (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={servers.length === 0}
              onClick={() => setExportOpen(true)}
            >
              <FileUp size={ICON_SM} />
              {s.portability.exportButton}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
              <FileDown size={ICON_SM} />
              {s.import.button}
            </Button>
            <Button size="sm" onClick={() => setFormMode({ kind: 'add' })}>
              <Plus size={ICON_SM} />
              {s.addServer}
            </Button>
          </div>
        )
      }
    >
      {isLoading ? (
        <SettingsLoading shape="card" count={2} />
      ) : error ? (
        <SettingsLoadError message={s.loadError} onRetry={() => void refetch()} />
      ) : servers.length === 0 ? (
        <Card padded={false}>
          <EmptyState icon={<Server size={24} />} title={s.empty} />
        </Card>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              onEdit={(target) => {
                setSubmitError(null);
                setFormMode({ kind: 'edit', server: target });
              }}
              onDelete={setServerToDelete}
            />
          ))}
        </div>
      )}

      {formMode && (
        <McpServerForm
          server={formMode.kind === 'edit' ? formMode.server : undefined}
          isSaving={addMutation.isPending || updateMutation.isPending}
          submitError={submitError}
          onSubmit={handleSubmit}
          onClose={closeForm}
        />
      )}

      {importOpen && <ImportServersDialog onClose={() => setImportOpen(false)} />}

      {exportOpen && <ExportServersDialog servers={servers} onClose={() => setExportOpen(false)} />}

      {serverToDelete && (
        <ConfirmDialog
          title={s.deleteServer}
          description={s.deleteConfirm}
          entityName={serverToDelete.name}
          confirmLabel={s.deleteServer}
          cancelLabel={s.cancelButton}
          isPending={deleteMutation.isPending}
          onConfirm={() => handleDelete(serverToDelete)}
          onCancel={() => setServerToDelete(null)}
        />
      )}
    </SettingsPage>
  );
}
