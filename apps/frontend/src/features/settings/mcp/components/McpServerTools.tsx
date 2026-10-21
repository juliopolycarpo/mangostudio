/**
 * Per-server tool list with enable/disable toggles. The list comes from the
 * server's discovery endpoint; enabled state and the toggle write go through
 * the shared tool-settings API under the namespaced `mcp__<slug>__<tool>` key.
 */

import type { McpServer } from '@mangostudio/shared/mcp';
import { useQuery } from '@tanstack/react-query';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsLoading } from '@/components/settings/SettingsStates';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { ToggleSwitch } from '@/components/ui/Toggle';
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
    return <SettingsLoading count={2} />;
  }

  if (toolsQuery.error) {
    return <Callout tone="danger">{s.toolsLoadError}</Callout>;
  }

  const tools = toolsQuery.data?.tools ?? [];
  if (tools.length === 0) {
    return <EmptyState title={s.noToolsDiscovered} className="min-h-0 py-4" />;
  }

  const enabledByName = new Map(descriptors.map((d) => [d.name, d.enabled]));

  return (
    <ul className="divide-y divide-stroke">
      {tools.map((tool) => {
        const settingsName = buildToolSettingsName(server.slug, tool.name);
        const enabled = enabledByName.get(settingsName) ?? true;
        return (
          <li key={tool.name}>
            <SettingsRow
              as="label"
              className="px-0 py-2"
              label={<span className="break-all font-mono">{tool.name}</span>}
              hint={tool.description}
            >
              <ToggleSwitch
                checked={enabled}
                disabled={isPending}
                onChange={() =>
                  updateToolSetting({ toolName: settingsName, body: { enabled: !enabled } })
                }
                aria-label={tool.name}
              />
            </SettingsRow>
          </li>
        );
      })}
    </ul>
  );
}
