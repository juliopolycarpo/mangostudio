import type { ExportMcpServersResponse, McpServer } from '@mangostudio/shared/mcp';
import { Check, Copy, Download, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-container-high w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl p-5 sm:p-8 shadow-2xl border border-outline-variant/20 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-xl font-bold text-on-surface">{s.portability.exportTitle}</h3>
            <p className="mt-1 text-sm text-on-surface-variant/70">
              {s.portability.exportDescription}
            </p>
          </div>
          <Button variant="ghost" size="sm" aria-label={s.cancelButton} onClick={onClose}>
            <X size={16} />
          </Button>
        </div>

        {preview ? (
          <div className="space-y-3">
            <textarea
              readOnly
              aria-label={s.portability.exportTitle}
              value={preview.content}
              rows={18}
              className="w-full rounded-2xl px-4 py-3 text-xs font-mono bg-surface-container-low text-on-surface border border-outline-variant/20 focus:outline-none resize-y"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void copyJson()}>
                <Copy size={14} />
                {s.portability.copyJson}
              </Button>
              <Button size="sm" onClick={downloadJson}>
                <Download size={14} />
                {s.portability.downloadJson}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-on-surface-variant">
                {s.portability.selectedCount.replace('{count}', String(selected.size))}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set(servers.map((server) => server.id)))}
                >
                  {s.portability.selectAll}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  {s.portability.selectNone}
                </Button>
              </div>
            </div>
            <ul className="space-y-2">
              {servers.map((server) => {
                const checked = selected.has(server.id);
                return (
                  <li key={server.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-outline-variant/20 px-4 py-3 hover:border-primary/40 transition-colors">
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={() => toggleServer(server.id)}
                      />
                      <span
                        className={`grid size-5 place-items-center rounded-md border ${
                          checked
                            ? 'border-primary bg-primary text-on-primary'
                            : 'border-outline-variant/60'
                        }`}
                      >
                        {checked && <Check size={13} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-on-surface">
                          {server.name}
                        </span>
                        <span className="block truncate text-xs font-mono text-on-surface-variant/60">
                          {server.slug} · {s.transports[server.transport]}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            {preview ? s.portability.done : s.cancelButton}
          </Button>
          {!preview && (
            <Button
              className="flex-1"
              disabled={selected.size === 0}
              loading={exportMutation.isPending}
              onClick={handlePreview}
            >
              {exportMutation.isPending ? s.portability.exporting : s.portability.previewExport}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
