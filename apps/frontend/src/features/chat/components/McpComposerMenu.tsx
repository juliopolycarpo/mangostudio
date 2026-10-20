/**
 * Composer affordance for the MCP prompts and resources primitives: a popover
 * listing every enabled server's prompts (insertable templates, with a small
 * argument form when the prompt declares arguments) and resources (attached to
 * the current chat as context through the attachments pipeline).
 */

import type { ChatAttachment } from '@mangostudio/shared/chat';
import type { McpPromptDescriptor, McpServer } from '@mangostudio/shared/mcp';
import { useQuery } from '@tanstack/react-query';
import { FileText, Plug, SquareSlash, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { getMcpPrompt, readMcpResource } from '@/features/settings/mcp/api';
import {
  mcpServerListQueryOptions,
  mcpServerPromptsQueryOptions,
  mcpServerResourcesQueryOptions,
} from '@/features/settings/mcp/queries';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  flattenMcpPromptText,
  missingRequiredMcpArguments,
  serializeMcpPromptArguments,
} from '../lib/mcp-prompt-args';

interface McpComposerMenuProps {
  chatId: string | null;
  disabled?: boolean;
  onInsertPrompt: (text: string) => void;
  onAttachments: (attachments: ChatAttachment[]) => void;
}

interface ArgumentFormState {
  serverId: string;
  prompt: McpPromptDescriptor;
}

export function McpComposerMenu({
  chatId,
  disabled,
  onInsertPrompt,
  onAttachments,
}: McpComposerMenuProps) {
  const { t } = useI18n();
  const labels = t.chat.input;
  const [open, setOpen] = useState(false);
  const [argumentForm, setArgumentForm] = useState<ArgumentFormState | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const serversQuery = useQuery({ ...mcpServerListQueryOptions(), enabled: open });
  const servers = (serversQuery.data?.servers ?? []).filter((server) => server.enabled);

  const insertResolvedPrompt = async (
    serverId: string,
    prompt: McpPromptDescriptor,
    values: Record<string, string>
  ) => {
    setBusy(true);
    setErrorText(null);
    try {
      const response = await getMcpPrompt(serverId, {
        name: prompt.name,
        arguments: serializeMcpPromptArguments(prompt.arguments, values),
      });
      onInsertPrompt(flattenMcpPromptText(response));
      setArgumentForm(null);
      setOpen(false);
    } catch (error) {
      setErrorText(resolveApiErrorMessage(error, labels.mcpInsertFailed));
    } finally {
      setBusy(false);
    }
  };

  const handlePromptClick = (serverId: string, prompt: McpPromptDescriptor) => {
    if (prompt.arguments.length > 0) {
      setArgumentForm({ serverId, prompt });
      return;
    }
    void insertResolvedPrompt(serverId, prompt, {});
  };

  const handleResourceClick = async (serverId: string, uri: string) => {
    if (!chatId) return;
    setBusy(true);
    setErrorText(null);
    try {
      const response = await readMcpResource(serverId, { uri, chatId });
      onAttachments(response.attachments ?? []);
      setOpen(false);
    } catch (error) {
      setErrorText(resolveApiErrorMessage(error, labels.mcpAttachFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          setErrorText(null);
        }}
        disabled={disabled}
        aria-expanded={open}
        className="terminal-chip composer-tool-chip"
        title={labels.mcpMenuButton}
      >
        <Plug size={12} className="shrink-0" />
        <span className="hidden sm:inline">MCP</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 w-80 max-h-96 overflow-y-auto rounded-2xl border border-stroke bg-surface p-3 shadow-2xl space-y-3">
          {serversQuery.isLoading && <p className="text-xs text-fg-muted">{t.common.loading}</p>}
          {!serversQuery.isLoading && servers.length === 0 && (
            <p className="text-xs text-fg-muted">{labels.mcpMenuEmpty}</p>
          )}
          {errorText && (
            <p className="text-xs text-danger" role="alert">
              {errorText}
            </p>
          )}
          {servers.map((server) => (
            <McpServerMenuSection
              key={server.id}
              server={server}
              chatId={chatId}
              busy={busy}
              onPromptClick={handlePromptClick}
              onResourceClick={(serverId, uri) => void handleResourceClick(serverId, uri)}
            />
          ))}
        </div>
      )}

      {argumentForm && (
        <McpPromptArgumentDialog
          prompt={argumentForm.prompt}
          busy={busy}
          onCancel={() => setArgumentForm(null)}
          onSubmit={(values) =>
            void insertResolvedPrompt(argumentForm.serverId, argumentForm.prompt, values)
          }
        />
      )}
    </div>
  );
}

interface McpServerMenuSectionProps {
  server: McpServer;
  chatId: string | null;
  busy: boolean;
  onPromptClick: (serverId: string, prompt: McpPromptDescriptor) => void;
  onResourceClick: (serverId: string, uri: string) => void;
}

function McpServerMenuSection({
  server,
  chatId,
  busy,
  onPromptClick,
  onResourceClick,
}: McpServerMenuSectionProps) {
  const { t } = useI18n();
  const labels = t.chat.input;
  const promptsQuery = useQuery(mcpServerPromptsQueryOptions(server.id));
  const resourcesQuery = useQuery(mcpServerResourcesQueryOptions(server.id));

  const prompts = promptsQuery.data?.prompts ?? [];
  const resources = resourcesQuery.data?.resources ?? [];
  if (promptsQuery.isLoading || resourcesQuery.isLoading) {
    return <p className="text-xs text-fg-muted">{t.common.loading}</p>;
  }
  // A tools-only server (both capabilities unsupported) has nothing to offer.
  if (prompts.length === 0 && resources.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-widest text-fg-muted">{server.name}</p>

      {prompts.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-fg-subtle">{labels.mcpPromptsSection}</p>
          {prompts.map((prompt) => (
            <button
              key={prompt.name}
              type="button"
              disabled={busy}
              onClick={() => onPromptClick(server.id, prompt)}
              className="flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-fill-hover transition-colors disabled:opacity-50"
            >
              <SquareSlash size={13} className="mt-0.5 shrink-0 text-accent-fg" />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-fg">{prompt.name}</span>
                {prompt.description && (
                  <span className="block truncate text-[11px] text-fg-muted">
                    {prompt.description}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {resources.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-fg-subtle">{labels.mcpResourcesSection}</p>
          {!chatId && <p className="px-2 text-[11px] text-fg-muted">{labels.mcpNeedsChat}</p>}
          {resources.map((resource) => (
            <button
              key={resource.uri}
              type="button"
              disabled={busy || !chatId}
              onClick={() => onResourceClick(server.id, resource.uri)}
              className="flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-fill-hover transition-colors disabled:opacity-50"
            >
              <FileText size={13} className="mt-0.5 shrink-0 text-accent-fg" />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-fg">{resource.name}</span>
                <span className="block truncate text-[11px] text-fg-muted">{resource.uri}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface McpPromptArgumentDialogProps {
  prompt: McpPromptDescriptor;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}

function McpPromptArgumentDialog({
  prompt,
  busy,
  onCancel,
  onSubmit,
}: McpPromptArgumentDialogProps) {
  const { t } = useI18n();
  const labels = t.chat.input;
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = missingRequiredMcpArguments(prompt.arguments, values);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim animate-in fade-in duration-200">
      <div className="bg-surface w-full max-w-sm rounded-3xl p-5 sm:p-6 shadow-2xl border border-stroke space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-fg">{labels.mcpPromptArgsTitle}</h3>
            <p className="truncate text-xs text-fg-muted">{prompt.name}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1 text-fg-muted hover:text-fg"
            aria-label={labels.mcpPromptCancel}
          >
            <X size={16} />
          </button>
        </div>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (missing.length === 0) onSubmit(values);
          }}
        >
          {prompt.arguments.map((argument) => (
            <label key={argument.name} className="block space-y-1">
              <span className="flex items-center gap-2 text-xs font-medium text-fg">
                {argument.name}
                {argument.required && (
                  <span className="rounded-full bg-accent-subtle px-1.5 py-0.5 text-[9px] text-accent-fg">
                    {labels.mcpArgRequired}
                  </span>
                )}
              </span>
              {argument.description && (
                <span className="block text-[11px] text-fg-muted">{argument.description}</span>
              )}
              <input
                type="text"
                value={values[argument.name] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [argument.name]: event.target.value }))
                }
                className="w-full rounded-xl border border-stroke bg-control px-3 py-2 text-sm text-fg outline-none focus:border-focus"
              />
            </label>
          ))}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="subtle" size="sm" type="button" onClick={onCancel}>
              {labels.mcpPromptCancel}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              loading={busy}
              disabled={missing.length > 0}
            >
              {labels.mcpPromptInsert}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
