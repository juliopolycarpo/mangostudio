import type { ExportMcpServersResponse, McpServer } from '@mangostudio/shared/mcp';
import { Copy, Download } from 'lucide-react';
import { useState } from 'react';

import { CheckboxRow } from '@/components/settings/CheckboxRow';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';

import { useExportPortableMcpServers } from '../hooks/use-mcp-servers';

interface ExportServersDialogProps {
  servers: McpServer[];
  onClose: () => void;
}

export function ExportServersDialog({ servers, onClose }: ExportServersDialogProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;
  const { toast } = useToast();
  const { copy } = useClipboard();
  const [selected, setSelected] = useState(() => new Set(servers.map((server) => server.id)));
  const [preview, setPreview] = useState<ExportMcpServersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exportMutation = useExportPortableMcpServers();

  const toggleServer = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };

  const handlePreview = () => {
    if (selected.size === 0) return;
    setError(null);
    // Always name the selected ids: `all` would resolve against the server's
    // current rows, which can hold servers this list never offered.
    exportMutation.mutate(
      { serverIds: [...selected] },
      {
        onSuccess: setPreview,
        onError: (cause) => setError(resolveApiErrorMessage(cause, s.portability.exportFailed)),
      }
    );
  };

  const copyJson = async () => {
    if (!preview) return;
    // An insecure context (or a denied permission) rejects the clipboard write.
    // Say so — a silent no-op reads as "copied" and the JSON is lost.
    if (await copy(preview.content)) {
      setError(null);
      toast(s.portability.copiedJson, 'success');
      return;
    }
    setError(s.portability.copyJsonFailed);
  };

  const downloadJson = () => {
    if (!preview) return;
    const url = URL.createObjectURL(new Blob([preview.content], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = preview.filename;
    anchor.click();
    // Revoking in the same tick cancels the download in Firefox and Safari,
    // which resolve the blob asynchronously after the synthetic click.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <Dialog
      title={s.portability.exportTitle}
      description={s.portability.exportDescription}
      closeDisabled={exportMutation.isPending}
      onClose={onClose}
      toolbar={
        preview ? undefined : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-fg-muted">
              {s.portability.selectedCount.replace('{count}', String(selected.size))}
            </span>
            <div className="flex gap-2">
              <Button
                variant="subtle"
                size="sm"
                onClick={() => setSelected(new Set(servers.map((server) => server.id)))}
              >
                {s.portability.selectAll}
              </Button>
              <Button variant="subtle" size="sm" onClick={() => setSelected(new Set())}>
                {s.portability.selectNone}
              </Button>
            </div>
          </div>
        )
      }
      notice={error ? <Callout tone="danger">{error}</Callout> : undefined}
      footer={
        preview ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {s.portability.done}
            </Button>
            <Button variant="secondary" onClick={() => void copyJson()}>
              <Copy size={ICON_SM} />
              {s.portability.copyJson}
            </Button>
            <Button onClick={downloadJson}>
              <Download size={ICON_SM} />
              {s.portability.downloadJson}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {s.cancelButton}
            </Button>
            <Button
              disabled={selected.size === 0}
              loading={exportMutation.isPending}
              onClick={handlePreview}
            >
              {exportMutation.isPending ? s.portability.exporting : s.portability.previewExport}
            </Button>
          </>
        )
      }
    >
      {preview ? (
        <Textarea
          readOnly
          aria-label={s.portability.exportTitle}
          value={preview.content}
          rows={18}
          className="font-mono text-xs"
        />
      ) : (
        <ul className="space-y-2">
          {servers.map((server) => (
            <li key={server.id}>
              <CheckboxRow
                label={server.name}
                description={`${server.slug} · ${s.transports[server.transport]}`}
                checked={selected.has(server.id)}
                onChange={() => toggleServer(server.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
