/**
 * Composer affordance for the MCP prompts and resources primitives: a popover
 * listing every enabled server's prompts (insertable templates, with a small
 * argument form when the prompt declares arguments) and resources (attached to
 * the current chat as context through the attachments pipeline).
 *
 * This file is the chip, the popover shell and the actions; the catalog and the
 * argument form (`McpMenuParts`) are lazy chunks that hovering or focusing the
 * chip, or pressing it, fetches.
 */

import type { ChatAttachment } from '@mangostudio/shared/chat';
import type { McpPromptDescriptor } from '@mangostudio/shared/mcp';
import { Plug } from 'lucide-react';
import { useState } from 'react';

import { createLazyOverlay } from '@/components/layout/LazyOverlay';
import { Callout } from '@/components/ui/Callout';
import { ComposerPopover } from '@/components/ui/ComposerPopover';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { getMcpPrompt, readMcpResource } from '@/features/settings/mcp/api';
import { useDismissable } from '@/hooks/use-dismissable';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';

import { flattenMcpPromptText, serializeMcpPromptArguments } from '../lib/mcp-prompt-args';
import type { McpMenuCatalogProps, McpPromptArgumentDialogProps } from './McpMenuParts';

const mcpMenuCatalog = createLazyOverlay<McpMenuCatalogProps>(() =>
  import('./McpMenuParts').then((module) => ({ default: module.McpMenuCatalog }))
);
const mcpPromptArgumentDialog = createLazyOverlay<McpPromptArgumentDialogProps>(() =>
  import('./McpMenuParts').then((module) => ({ default: module.McpPromptArgumentDialog }))
);

/** Both overlays share one chunk, so warming either warms the other. */
function preloadMcpMenuParts(): void {
  mcpMenuCatalog.preload();
}

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
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape is handled for the trigger and the panel it owns, both inside this wrapper. */}
      <div ref={containerRef} onKeyDown={onKeyDown}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setOpen((value) => !value);
            setErrorText(null);
          }}
          onPointerEnter={preloadMcpMenuParts}
          onFocus={preloadMcpMenuParts}
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
            <mcpMenuCatalog.Overlay
              chatId={chatId}
              busy={busy}
              onPromptClick={handlePromptClick}
              onResourceClick={(serverId, uri) => void handleResourceClick(serverId, uri)}
              onLoadFailed={() => setOpen(false)}
            />
          </ComposerPopover>
        )}
      </div>

      {/* Outside the wrapper above, so an Escape typed in the form closes the form
          (the dialog's own listener) instead of being taken by the menu, and a
          press in it is not read as a press on the menu. */}
      {argumentForm && (
        <mcpPromptArgumentDialog.Overlay
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
          onLoadFailed={() => setArgumentForm(null)}
        />
      )}
    </>
  );
}
