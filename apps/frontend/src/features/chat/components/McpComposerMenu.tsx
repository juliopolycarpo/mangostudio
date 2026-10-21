/**
 * Composer affordance for the MCP prompts and resources primitives: a popover
 * listing every enabled server's prompts (insertable templates, with a small
 * argument form when the prompt declares arguments) and resources (attached to
 * the current chat as context through the attachments pipeline).
 */

import type { ChatAttachment } from '@mangostudio/shared/chat';
import type { McpPromptDescriptor, McpServer } from '@mangostudio/shared/mcp';
import { useQuery } from '@tanstack/react-query';
import { FileText, Plug, SquareSlash } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { FIELD_CLASS } from '@/components/ui/Input';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { getMcpPrompt, readMcpResource } from '@/features/settings/mcp/api';
import {
  mcpServerListQueryOptions,
  mcpServerPromptsQueryOptions,
  mcpServerResourcesQueryOptions,
} from '@/features/settings/mcp/queries';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  flattenMcpPromptText,
  missingRequiredMcpArguments,
  serializeMcpPromptArguments,
} from '../lib/mcp-prompt-args';
import { ComposerPopover } from './ComposerPopover';
import { DialogBody, DialogFooter, DialogFrame } from './DialogFrame';

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
        <Plug size={ICON_SM} className="shrink-0" />
        <span className="hidden sm:inline">MCP</span>
      </button>

      {open && (
        <ComposerPopover className="max-h-96 space-y-3 overflow-y-auto p-3">
          {serversQuery.isLoading && <p className="text-xs text-fg-muted">{t.common.loading}</p>}
          {!serversQuery.isLoading && servers.length === 0 && (
            <p className="text-xs text-fg-muted">{labels.mcpMenuEmpty}</p>
          )}
          {errorText && <Callout tone="danger" role="alert" title={errorText} />}
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
        </ComposerPopover>
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
      <MicroLabel as="p">{server.name}</MicroLabel>

      {prompts.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-fg-muted">{labels.mcpPromptsSection}</p>
          {prompts.map((prompt) => (
            <McpEntryButton
              key={prompt.name}
              icon={<SquareSlash size={ICON_MD} />}
              title={prompt.name}
              detail={prompt.description}
              disabled={busy}
              onClick={() => onPromptClick(server.id, prompt)}
            />
          ))}
        </div>
      )}

      {resources.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-fg-muted">{labels.mcpResourcesSection}</p>
          {!chatId && <p className="px-2 text-xs text-fg-muted">{labels.mcpNeedsChat}</p>}
          {resources.map((resource) => (
            <McpEntryButton
              key={resource.uri}
              icon={<FileText size={ICON_MD} />}
              title={resource.name}
              detail={resource.uri}
              disabled={busy || !chatId}
              onClick={() => onResourceClick(server.id, resource.uri)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One insertable prompt or attachable resource: a glyph, a name and a one-line detail. */
function McpEntryButton({
  icon,
  title,
  detail,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail?: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="mt-0.5 shrink-0 text-fg-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">{title}</span>
        {detail ? <span className="block truncate text-xs text-fg-muted">{detail}</span> : null}
      </span>
    </button>
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
    <DialogFrame>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (missing.length === 0) onSubmit(values);
        }}
      >
        <DialogBody>
          <div className="min-w-0 space-y-1">
            <h3 className="text-title font-semibold text-fg">{labels.mcpPromptArgsTitle}</h3>
            <p className="truncate font-mono text-xs text-fg-muted">{prompt.name}</p>
          </div>

          {prompt.arguments.map((argument) => (
            <label key={argument.name} className="block space-y-1">
              <span className="flex items-center gap-2 text-sm font-medium text-fg">
                {argument.name}
                {argument.required && <Badge variant="neutral">{labels.mcpArgRequired}</Badge>}
              </span>
              <input
                type="text"
                value={values[argument.name] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [argument.name]: event.target.value }))
                }
                className={FIELD_CLASS}
              />
              {argument.description && (
                <span className="block text-xs text-fg-muted">{argument.description}</span>
              )}
            </label>
          ))}
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" type="button" onClick={onCancel}>
            {labels.mcpPromptCancel}
          </Button>
          <Button type="submit" loading={busy} disabled={missing.length > 0}>
            {labels.mcpPromptInsert}
          </Button>
        </DialogFooter>
      </form>
    </DialogFrame>
  );
}
