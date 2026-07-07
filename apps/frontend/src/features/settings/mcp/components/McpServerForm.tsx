/**
 * Add/edit modal form for an MCP server. Fields switch on transport; only the
 * active transport's fields are submitted. Server-side TypeBox schemas remain
 * the source of truth — API validation errors surface through the caller.
 */

import type { McpServer, McpTransport } from '@mangostudio/shared/mcp';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Toggle } from '@/components/ui/Toggle';
import { useI18n } from '@/hooks/use-i18n';
import {
  createEmptyFormState,
  formStateFromServer,
  type McpServerFormErrors,
  type McpServerFormState,
  validateFormState,
} from '../lib/server-form';
import { KeyValueListField } from './KeyValueListField';

interface McpServerFormProps {
  /** Present when editing; absent when adding. */
  server?: McpServer;
  isSaving: boolean;
  /** Error surfaced from the API after a failed save. */
  submitError: string | null;
  onSubmit: (state: McpServerFormState) => void;
  onClose: () => void;
}

const TRANSPORTS: McpTransport[] = ['stdio', 'http'];

export function McpServerForm({
  server,
  isSaving,
  submitError,
  onSubmit,
  onClose,
}: McpServerFormProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;

  const [state, setState] = useState<McpServerFormState>(() =>
    server ? formStateFromServer(server) : createEmptyFormState()
  );
  const [errors, setErrors] = useState<McpServerFormErrors>({});

  const patch = (updates: Partial<McpServerFormState>) =>
    setState((prev) => ({ ...prev, ...updates }));

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const validationErrors = validateFormState(state, s);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    onSubmit(state);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-container-high w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-3xl p-5 sm:p-8 shadow-2xl border border-outline-variant/20">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-on-surface">
              {server ? s.editServer : s.addServer}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={s.cancelButton}
              onClick={onClose}
            >
              <X size={16} />
            </Button>
          </div>

          <Input
            id="mcp-server-name"
            label={s.nameLabel}
            value={state.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder={s.namePlaceholder}
            error={errors.name}
          />

          <div className="space-y-1.5">
            <Input
              id="mcp-server-slug"
              label={s.slugLabel}
              value={state.slug}
              onChange={(e) => patch({ slug: e.target.value })}
              placeholder={s.slugPlaceholder}
              error={errors.slug}
            />
            <p className="text-xs text-on-surface-variant/60">{s.slugHint}</p>
          </div>

          {/* ── Transport switch ── */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-on-surface-variant">{s.transportLabel}</span>
            <div className="flex gap-2">
              {TRANSPORTS.map((transport) => (
                <button
                  key={transport}
                  type="button"
                  onClick={() => patch({ transport })}
                  className={`px-4 py-2 text-sm font-medium rounded-xl border transition-colors ${
                    state.transport === transport
                      ? 'bg-primary/10 border-primary/60 text-primary'
                      : 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {s.transports[transport]}
                </button>
              ))}
            </div>
          </div>

          {state.transport === 'stdio' ? (
            <>
              <div className="flex items-start gap-2 rounded-xl bg-error/5 border border-error/20 p-3 text-xs text-on-surface-variant">
                <AlertTriangle size={14} className="text-error shrink-0 mt-0.5" />
                <span>{s.stdioTrustWarning}</span>
              </div>

              <Input
                id="mcp-server-command"
                label={s.commandLabel}
                value={state.command}
                onChange={(e) => patch({ command: e.target.value })}
                placeholder={s.commandPlaceholder}
                error={errors.command}
              />

              {/* ── Args list ── */}
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-on-surface-variant">{s.argsLabel}</span>
                <div className="space-y-2">
                  {state.args.map((arg, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable identity while being typed
                    <div key={index} className="flex items-center gap-2">
                      <input
                        value={arg}
                        onChange={(e) =>
                          patch({
                            args: state.args.map((a, i) => (i === index ? e.target.value : a)),
                          })
                        }
                        placeholder={s.argPlaceholder}
                        aria-label={`${s.argsLabel} ${index + 1}`}
                        className="flex-1 min-w-0 rounded-xl px-3 py-2 text-sm bg-surface-container-high text-on-surface border border-outline-variant/20 placeholder:text-on-surface/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={s.removeEntry}
                        onClick={() => patch({ args: state.args.filter((_, i) => i !== index) })}
                      >
                        <X size={14} />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => patch({ args: [...state.args, ''] })}
                >
                  <Plus size={14} />
                  {s.addEntry}
                </Button>
              </div>

              <KeyValueListField
                label={s.envLabel}
                hint={s.envHint}
                entries={state.env}
                onChange={(env) => patch({ env })}
              />
            </>
          ) : (
            <>
              <Input
                id="mcp-server-url"
                label={s.urlLabel}
                value={state.url}
                onChange={(e) => patch({ url: e.target.value })}
                placeholder={s.urlPlaceholder}
                error={errors.url}
              />

              {server && server.headerNames.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {server.headerNames.map((headerName) => (
                    <span
                      key={headerName}
                      className="inline-flex items-center gap-1.5 rounded-full bg-surface-container-highest px-3 py-1 text-xs text-on-surface-variant"
                    >
                      <span className="font-medium text-on-surface">{headerName}</span>
                      <span aria-hidden>••••••</span>
                      <span className="sr-only">{s.storedHeaderValue}</span>
                    </span>
                  ))}
                </div>
              )}

              <KeyValueListField
                label={s.headersLabel}
                hint={s.headersHint}
                entries={state.headers}
                onChange={(headers) => patch({ headers })}
                secretValues
              />
            </>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
            <div className="space-y-1.5">
              <Input
                id="mcp-server-timeout"
                type="number"
                min={1}
                label={s.timeoutLabel}
                value={state.timeoutMs}
                onChange={(e) => patch({ timeoutMs: e.target.value })}
              />
              <p className="text-xs text-on-surface-variant/60">{s.timeoutHint}</p>
            </div>
            <div className="pb-6">
              <Toggle
                id="mcp-server-enabled"
                label={state.enabled ? s.enabledLabel : s.disabledLabel}
                checked={state.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
            </div>
          </div>

          {submitError && <p className="text-sm text-error">{submitError}</p>}

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
              {s.cancelButton}
            </Button>
            <Button type="submit" variant="primary" className="flex-1" loading={isSaving}>
              {isSaving ? s.savingButton : s.saveButton}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
