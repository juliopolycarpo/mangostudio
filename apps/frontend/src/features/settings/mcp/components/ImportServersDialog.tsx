/**
 * Two-step import dialog: pick a source (file path on the API host, or pasted
 * JSON), preview what the API would create, tick the wanted entries, confirm.
 * The copy is one-shot — the server keeps no link back to the file.
 */

import type { McpImportPreviewEntry, PreviewMcpImportBody } from '@mangostudio/shared/mcp';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { useImportMcpServers, usePreviewMcpImport } from '../hooks/use-mcp-servers';

interface ImportServersDialogProps {
  onClose: () => void;
}

type SourceKind = 'path' | 'json';

type Step =
  | { kind: 'source' }
  | { kind: 'preview'; entries: McpImportPreviewEntry[]; selected: ReadonlySet<string> };

export function ImportServersDialog({ onClose }: ImportServersDialogProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;
  const { toast } = useToast();

  const [sourceKind, setSourceKind] = useState<SourceKind>('path');
  const [path, setPath] = useState('');
  const [json, setJson] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'source' });
  const [submitError, setSubmitError] = useState<string | null>(null);

  const previewMutation = usePreviewMcpImport();
  const importMutation = useImportMcpServers();

  const sourceBody = (): PreviewMcpImportBody | null => {
    const value = (sourceKind === 'path' ? path : json).trim();
    if (value.length === 0) return null;
    return sourceKind === 'path' ? { path: value } : { json: value };
  };

  const handlePreview = () => {
    const body = sourceBody();
    if (!body) {
      setSubmitError(s.import.sourceRequired);
      return;
    }
    setSubmitError(null);
    previewMutation.mutate(body, {
      onSuccess: ({ entries }) => {
        const selected = new Set(
          entries.filter((entry) => entry.action === 'create').map((entry) => entry.slug)
        );
        setStep({ kind: 'preview', entries, selected });
      },
      onError: (error) => setSubmitError(error.message),
    });
  };

  const toggleSlug = (slug: string) => {
    if (step.kind !== 'preview') return;
    const selected = new Set(step.selected);
    if (!selected.delete(slug)) selected.add(slug);
    setStep({ ...step, selected });
  };

  const handleImport = () => {
    const body = sourceBody();
    if (step.kind !== 'preview' || !body || step.selected.size === 0) return;
    setSubmitError(null);
    importMutation.mutate(
      { ...body, slugs: [...step.selected] },
      {
        onSuccess: ({ results }) => {
          const created = results.filter((result) => result.result === 'created').length;
          toast(
            created > 0
              ? s.import.successToast.replace('{count}', String(created))
              : s.import.nothingImportedToast,
            created > 0 ? 'success' : 'error'
          );
          onClose();
        },
        onError: (error) => setSubmitError(error.message),
      }
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-container-high w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-3xl p-5 sm:p-8 shadow-2xl border border-outline-variant/20 space-y-5">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-bold text-on-surface">{s.import.title}</h3>
          <Button variant="ghost" size="sm" aria-label={s.cancelButton} onClick={onClose}>
            <X size={16} />
          </Button>
        </div>

        <p className="text-sm text-on-surface-variant/70">{s.import.description}</p>

        {step.kind === 'source' ? (
          <>
            <div className="flex gap-2">
              {(['path', 'json'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setSourceKind(kind)}
                  className={`px-4 py-2 text-sm font-medium rounded-xl border transition-colors ${
                    sourceKind === kind
                      ? 'bg-primary/10 border-primary/60 text-primary'
                      : 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {kind === 'path' ? s.import.sourcePath : s.import.sourceJson}
                </button>
              ))}
            </div>

            {sourceKind === 'path' ? (
              <div className="space-y-1.5">
                <Input
                  id="mcp-import-path"
                  label={s.import.pathLabel}
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder={s.import.pathPlaceholder}
                />
                <p className="text-xs text-on-surface-variant/60">{s.import.pathHint}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="mcp-import-json"
                  className="text-sm font-medium text-on-surface-variant"
                >
                  {s.import.jsonLabel}
                </label>
                <textarea
                  id="mcp-import-json"
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  placeholder={s.import.jsonPlaceholder}
                  rows={8}
                  className="rounded-xl px-3 py-2 text-sm font-mono bg-surface-container-high text-on-surface border border-outline-variant/20 placeholder:text-on-surface/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors resize-y"
                />
              </div>
            )}
          </>
        ) : (
          <ImportPreviewList
            entries={step.entries}
            selected={step.selected}
            onToggle={toggleSlug}
          />
        )}

        {submitError && <p className="text-sm text-error">{submitError}</p>}

        <div className="flex gap-3 pt-2">
          {step.kind === 'source' ? (
            <>
              <Button variant="secondary" className="flex-1" onClick={onClose}>
                {s.cancelButton}
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                loading={previewMutation.isPending}
                onClick={handlePreview}
              >
                {previewMutation.isPending ? s.import.previewingButton : s.import.previewButton}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setSubmitError(null);
                  setStep({ kind: 'source' });
                }}
              >
                {s.import.backButton}
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                disabled={step.selected.size === 0}
                loading={importMutation.isPending}
                onClick={handleImport}
              >
                {importMutation.isPending
                  ? s.import.importingButton
                  : s.import.importButton.replace('{count}', String(step.selected.size))}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface ImportPreviewListProps {
  entries: McpImportPreviewEntry[];
  selected: ReadonlySet<string>;
  onToggle: (slug: string) => void;
}

function ImportPreviewList({ entries, selected, onToggle }: ImportPreviewListProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;

  if (entries.length === 0) {
    return (
      <p className="text-sm text-on-surface-variant/60 text-center py-6">{s.import.emptyPreview}</p>
    );
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry, index) => {
        const importable = entry.action === 'create';
        return (
          <li
            // Duplicate slugs can repeat within one source, so key by position too.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={`${entry.slug}-${index}`}
            className={`rounded-xl border border-outline-variant/20 p-3 ${importable ? '' : 'opacity-60'}`}
          >
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                checked={importable && selected.has(entry.slug)}
                disabled={!importable}
                onChange={() => onToggle(entry.slug)}
              />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-on-surface truncate">{entry.name}</span>
                  {entry.transport && (
                    <span className="text-xs rounded-full bg-surface-container-highest px-2 py-0.5 text-on-surface-variant">
                      {s.transports[entry.transport]}
                    </span>
                  )}
                </span>
                <span className="block text-xs font-mono text-on-surface-variant/70 truncate">
                  {entry.command ?? entry.url ?? entry.key}
                </span>
                {entry.reason && (
                  <span className="block text-xs text-error">
                    {s.import.reasons[entry.reason]}
                    {entry.detail ? ` (${entry.detail})` : ''}
                  </span>
                )}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
