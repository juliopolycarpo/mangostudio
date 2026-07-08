/**
 * MCP settings page: server list with live-ish status, add/edit form modal,
 * and delete confirmation.
 */

import type { McpServer } from '@mangostudio/shared/mcp';
import { FileDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import {
  useAddMcpServer,
  useDeleteMcpServer,
  useMcpServers,
  useUpdateMcpServer,
} from '../hooks/use-mcp-servers';
import { buildAddBody, buildUpdateBody, type McpServerFormState } from '../lib/server-form';
import { DeleteServerDialog } from './DeleteServerDialog';
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
        onError: (err) => setSubmitError(err.message),
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
        onError: (err) => setSubmitError(err.message),
      }
    );
  };

  const handleDelete = (server: McpServer) => {
    deleteMutation.mutate(server.id, {
      onSuccess: () => toast(s.deleteSuccess, 'success'),
      onError: (err) => toast(err.message, 'error'),
      onSettled: () => setServerToDelete(null),
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-on-surface-variant">{t.common.loading}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-error">{s.loadError}</p>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          {t.common.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <p className="text-sm text-on-surface-variant/60">{s.description}</p>
        <div className="flex gap-2 shrink-0">
          <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
            <FileDown size={14} />
            {s.import.button}
          </Button>
          <Button size="sm" onClick={() => setFormMode({ kind: 'add' })}>
            <Plus size={14} />
            {s.addServer}
          </Button>
        </div>
      </div>

      {servers.length === 0 ? (
        <p className="text-sm text-on-surface-variant/60 text-center py-8">{s.empty}</p>
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

      {serverToDelete && (
        <DeleteServerDialog
          server={serverToDelete}
          isDeleting={deleteMutation.isPending}
          onConfirm={() => handleDelete(serverToDelete)}
          onCancel={() => setServerToDelete(null)}
        />
      )}
    </div>
  );
}
