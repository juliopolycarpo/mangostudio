/**
 * Composer affordance for the MCP prompts and resources primitives: a popover
 * listing every enabled server's prompts (insertable templates, with a small
 * argument form when the prompt declares arguments) and resources (attached to
 * the current chat as context through the attachments pipeline).
 */

import type { ChatAttachment } from '@mangostudio/shared/chat';
import type {
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpServer,
} from '@mangostudio/shared/mcp';
import { useQueries, useQuery } from '@tanstack/react-query';
import { FileText, Plug, SquareSlash } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { FIELD_CLASS } from '@/components/ui/Input';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { getMcpPrompt, readMcpResource } from '@/features/settings/mcp/api';
import {
  mcpServerListQueryOptions,
  mcpServerPromptsQueryOptions,
  mcpServerResourcesQueryOptions,
} from '@/features/settings/mcp/queries';
import { useDismissable } from '@/hooks/use-dismissable';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  flattenMcpPromptText,
  missingRequiredMcpArguments,
  serializeMcpPromptArguments,
} from '../lib/mcp-prompt-args';
import { ComposerPopover } from './ComposerPopover';

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
  const { containerRef, triggerRef, onKeyDown } = useDismissable(open, () => setOpen(false));
  const [argumentForm, setArgumentForm] = useState<ArgumentFormState | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      // The form is a modal: the menu behind it would be one more layer to
      // dismiss, and the press that lands in the dialog is outside the menu.
      setOpen(false);
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
    <>
      {/* Not `relative`: the panel is anchored to the composer, not to this chip. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled for the trigger and the panel it owns, both inside this wrapper. */}
      <div ref={containerRef} onKeyDown={onKeyDown}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setOpen((value) => !value);
            setErrorText(null);
          }}
          disabled={disabled}
          aria-expanded={open}
          className="composer-chip composer-tool-chip"
          title={labels.mcpMenuButton}
        >
          <Plug size={ICON_SM} className="shrink-0" />
          <span className="hidden sm:inline">{t.tools.sources.mcp}</span>
        </button>

        {open && (
          <ComposerPopover
            anchor={triggerRef}
            className="app-scrollbar max-h-96 space-y-3 overflow-y-auto p-3"
          >
            <MicroLabel as="p">{labels.mcpMenuButton}</MicroLabel>
            {errorText && <Callout tone="danger" role="alert" title={errorText} />}
            <McpMenuCatalog
              chatId={chatId}
              busy={busy}
              onPromptClick={handlePromptClick}
              onResourceClick={(serverId, uri) => void handleResourceClick(serverId, uri)}
            />
          </ComposerPopover>
        )}
      </div>

      {/* Outside the wrapper above, so an Escape typed in the form closes the form
          (the dialog's own listener) instead of being taken by the menu, and a
          press in it is not read as a press on the menu. */}
      {argumentForm && (
        <McpPromptArgumentDialog
          prompt={argumentForm.prompt}
          busy={busy}
          // The menu is closed while the form is up, so a failed insert would
          // have nowhere to say so but here.
          errorText={errorText}
          onCancel={() => {
            setArgumentForm(null);
            setErrorText(null);
          }}
          onSubmit={(values) =>
            void insertResolvedPrompt(argumentForm.serverId, argumentForm.prompt, values)
          }
        />
      )}
    </>
  );
}

/** What one enabled server offers the menu, with how far the asking has got. */
interface McpServerCatalog {
  readonly server: McpServer;
  readonly prompts: readonly McpPromptDescriptor[];
  readonly resources: readonly McpResourceDescriptor[];
  /** Either listing is still on its way. */
  readonly loading: boolean;
  /** Either listing failed for a reason other than "this server doesn't do that". */
  readonly failed: boolean;
}

interface McpMenuCatalogProps {
  chatId: string | null;
  busy: boolean;
  onPromptClick: (serverId: string, prompt: McpPromptDescriptor) => void;
  onResourceClick: (serverId: string, uri: string) => void;
}

/**
 * The popover's body: every enabled server's prompts and resources, or the
 * reason there is nothing to show.
 *
 * The listings are asked for here rather than inside each server's section
 * because the panel has to know what its sections add up to. A tools-only
 * server (both capabilities unsupported — the most common kind) contributes
 * nothing, and when every server is like that the sections together drew an
 * empty bordered box with no word in it. Only mounted while the popover is
 * open, so nothing is fetched for a menu nobody opened.
 */
function McpMenuCatalog({ chatId, busy, onPromptClick, onResourceClick }: McpMenuCatalogProps) {
  const { t } = useI18n();
  const labels = t.chat.input;
  const serversQuery = useQuery(mcpServerListQueryOptions());
  const servers = (serversQuery.data?.servers ?? []).filter((server) => server.enabled);
  const promptQueries = useQueries({
    queries: servers.map((server) => mcpServerPromptsQueryOptions(server.id)),
  });
  const resourceQueries = useQueries({
    queries: servers.map((server) => mcpServerResourcesQueryOptions(server.id)),
  });

  // A refetch that fails keeps the list it had, so only a menu with nothing to
  // show can be a failed one — and the list failing is not "no prompts".
  if (!serversQuery.data) {
    return serversQuery.isError ? (
      <McpLoadFailed
        retrying={serversQuery.isFetching}
        onRetry={() => void serversQuery.refetch()}
      />
    ) : (
      <McpMenuLoading />
    );
  }

  const catalogs: McpServerCatalog[] = servers.map((server, index) => {
    const prompts = promptQueries[index];
    const resources = resourceQueries[index];
    return {
      server,
      prompts: prompts?.data?.prompts ?? [],
      resources: resources?.data?.resources ?? [],
      loading: Boolean(prompts?.isPending || resources?.isPending),
      failed: Boolean(prompts?.isError || resources?.isError),
    };
  });
  const loading = catalogs.some((catalog) => catalog.loading);
  const failed = catalogs.some((catalog) => catalog.failed);
  const hasContent = catalogs.some(
    (catalog) => catalog.prompts.length > 0 || catalog.resources.length > 0
  );
  const failedQueries = [...promptQueries, ...resourceQueries].filter((query) => query.isError);
  const retry = () => {
    for (const query of failedQueries) void query.refetch();
  };

  return (
    <>
      {catalogs.map((catalog) => (
        <McpServerMenuSection
          key={catalog.server.id}
          catalog={catalog}
          chatId={chatId}
          busy={busy}
          onPromptClick={onPromptClick}
          onResourceClick={onResourceClick}
        />
      ))}
      {/* A listing that failed is not an empty one: "exposes no prompts" would
          be false for exactly the servers the user is trying to reach. */}
      {failed && (
        <McpLoadFailed retrying={failedQueries.some((query) => query.isFetching)} onRetry={retry} />
      )}
      {!loading && !failed && !hasContent && (
        <p className="text-xs text-fg-muted">{labels.mcpMenuEmpty}</p>
      )}
    </>
  );
}

/** Rows' worth of grey while a listing is on its way, announced once as a status. */
function McpMenuLoading() {
  const { t } = useI18n();
  return (
    <div role="status" className="space-y-1">
      <span className="sr-only">{t.common.loading}</span>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

function McpLoadFailed({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <Callout
      tone="danger"
      role="alert"
      title={t.chat.input.mcpLoadFailed}
      action={
        <Button size="sm" variant="secondary" loading={retrying} onClick={onRetry}>
          {t.common.retry}
        </Button>
      }
    />
  );
}

interface McpServerMenuSectionProps {
  catalog: McpServerCatalog;
  chatId: string | null;
  busy: boolean;
  onPromptClick: (serverId: string, prompt: McpPromptDescriptor) => void;
  onResourceClick: (serverId: string, uri: string) => void;
}

function McpServerMenuSection({
  catalog,
  chatId,
  busy,
  onPromptClick,
  onResourceClick,
}: McpServerMenuSectionProps) {
  const { t } = useI18n();
  const labels = t.chat.input;
  const { server, prompts, resources } = catalog;

  if (catalog.loading) {
    return (
      <div className="space-y-2">
        <McpServerName>{server.name}</McpServerName>
        <McpMenuLoading />
      </div>
    );
  }
  // A tools-only server (both capabilities unsupported) has nothing to offer.
  // The menu says so once, for all of them, rather than each leaving a gap.
  if (prompts.length === 0 && resources.length === 0) return null;

  return (
    <div className="space-y-2">
      <McpServerName>{server.name}</McpServerName>

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

/**
 * A server's name over its entries. Not a second `MicroLabel`: the popover's own
 * title is one, and two upper-case mono lines in a row read as one heading
 * wrapped. A server is content, so it is drawn heavier than the `Prompts` and
 * `Resources` labels beneath it and in the text colour.
 */
function McpServerName({ children }: { children: ReactNode }) {
  return <p className="truncate text-sm font-semibold text-fg">{children}</p>;
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
  errorText: string | null;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}

function McpPromptArgumentDialog({
  prompt,
  busy,
  errorText,
  onCancel,
  onSubmit,
}: McpPromptArgumentDialogProps) {
  const { t } = useI18n();
  const labels = t.chat.input;
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = missingRequiredMcpArguments(prompt.arguments, values);

  return (
    <Dialog
      size="sm"
      title={labels.mcpPromptArgsTitle}
      description={<span className="block truncate font-mono text-xs">{prompt.name}</span>}
      onSubmit={(event) => {
        event.preventDefault();
        if (missing.length === 0) onSubmit(values);
      }}
      onClose={onCancel}
      notice={errorText ? <Callout tone="danger" role="alert" title={errorText} /> : undefined}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onCancel}>
            {labels.mcpPromptCancel}
          </Button>
          <Button type="submit" loading={busy} disabled={missing.length > 0}>
            {labels.mcpPromptInsert}
          </Button>
        </>
      }
    >
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
    </Dialog>
  );
}
