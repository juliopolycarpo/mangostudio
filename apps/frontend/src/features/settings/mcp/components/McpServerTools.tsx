/**
 * Per-server tool list with enable/disable toggles. The list comes from the
 * server's discovery endpoint; enabled state and the toggle write go through
 * the shared tool-settings API under the namespaced `mcp__<slug>__<tool>` key.
 */

import type { McpServer } from '@mangostudio/shared/mcp';
import { useQuery } from '@tanstack/react-query';
import {
  useToolSettings,
  useUpdateToolSetting,
} from '@/features/settings/tools/hooks/use-tool-settings';
import { useI18n } from '@/hooks/use-i18n';
import { mcpServerToolsQueryOptions } from '../queries';

interface McpServerToolsProps {
  server: McpServer;
}

function buildToolSettingsName(serverSlug: string, toolName: string): string {
  return `mcp__${serverSlug}__${toolName}`;
}

export function McpServerTools({ server }: McpServerToolsProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;

  const toolsQuery = useQuery(mcpServerToolsQueryOptions(server.id));
  const { descriptors } = useToolSettings();
  const { mutate: updateToolSetting, isPending } = useUpdateToolSetting();

  if (toolsQuery.isLoading) {
    return <p className="text-sm text-on-surface-variant py-2">{t.common.loading}</p>;
  }

  if (toolsQuery.error) {
    return <p className="text-sm text-error py-2">{s.toolsLoadError}</p>;
  }

  const tools = toolsQuery.data?.tools ?? [];
  if (tools.length === 0) {
    return <p className="text-sm text-on-surface-variant/60 py-2">{s.noToolsDiscovered}</p>;
  }

  const enabledByName = new Map(descriptors.map((d) => [d.name, d.enabled]));

  return (
    <ul className="space-y-2 py-2">
      {tools.map((tool) => {
        const settingsName = buildToolSettingsName(server.slug, tool.name);
        const enabled = enabledByName.get(settingsName) ?? true;
        return (
          <li
            key={tool.name}
            className="flex items-start justify-between gap-4 rounded-xl bg-surface-container-lowest/60 px-3 py-2"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-on-surface break-all">{tool.name}</p>
              {tool.description && (
                <p className="text-xs text-on-surface-variant/70 leading-relaxed">
                  {tool.description}
                </p>
              )}
            </div>
            <label className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-on-surface-variant">
                {enabled ? s.enabledLabel : s.disabledLabel}
              </span>
              <input
                type="checkbox"
                checked={enabled}
                disabled={isPending}
                onChange={() =>
                  updateToolSetting({ toolName: settingsName, body: { enabled: !enabled } })
                }
                aria-label={tool.name}
                className="h-4 w-4 rounded border-outline-variant/30 accent-primary"
              />
            </label>
          </li>
        );
      })}
    </ul>
  );
}
