/**
 * Per-server resource browser: lists the resources the server advertises and
 * previews a resource's text content inline on demand. Servers without the
 * resources capability get a quiet notice instead of an error.
 */

import type { McpServer, ReadMcpResourceResponse } from '@mangostudio/shared/mcp';
import { useQuery } from '@tanstack/react-query';
import { Eye, FileText } from 'lucide-react';
import { useState } from 'react';
import { SettingsLoading } from '@/components/settings/SettingsStates';
import { StatusNote } from '@/components/settings/StatusNote';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { readMcpResource } from '../api';
import { mcpServerResourcesQueryOptions } from '../queries';

interface McpServerResourcesProps {
  server: McpServer;
}

export function McpServerResources({ server }: McpServerResourcesProps) {
  const { t } = useI18n();
  const s = t.settings.mcp.resources;

  const resourcesQuery = useQuery(mcpServerResourcesQueryOptions(server.id));
  const [preview, setPreview] = useState<{
    uri: string;
    response?: ReadMcpResourceResponse;
    error?: string;
    loading: boolean;
  } | null>(null);

  const handlePreview = async (uri: string) => {
    setPreview({ uri, loading: true });
    try {
      const response = await readMcpResource(server.id, { uri });
      setPreview({ uri, response, loading: false });
    } catch (error) {
      setPreview({
        uri,
        error: resolveApiErrorMessage(error, s.readFailed),
        loading: false,
      });
    }
  };

  if (resourcesQuery.isLoading) {
    return <SettingsLoading count={2} />;
  }
  if (resourcesQuery.error) {
    return <Callout tone="danger">{s.loadError}</Callout>;
  }
  if (resourcesQuery.data === null) {
    return <EmptyState title={s.notSupported} className="min-h-0 py-4" />;
  }

  const resources = resourcesQuery.data?.resources ?? [];
  if (resources.length === 0) {
    return <EmptyState title={s.empty} className="min-h-0 py-4" />;
  }

  return (
    <ul className="divide-y divide-stroke">
      {resources.map((resource) => (
        <li key={resource.uri} className="space-y-2 py-2">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <p className="flex items-center gap-1.5 break-all text-sm font-medium text-fg">
                <FileText size={ICON_SM} className="shrink-0 text-fg-muted" aria-hidden="true" />
                {resource.name}
              </p>
              <p className="break-all font-mono text-xs text-fg-muted">{resource.uri}</p>
              {resource.description && (
                <p className="text-xs text-fg-muted">{resource.description}</p>
              )}
              {resource.mimeType && (
                <p className="font-mono text-micro text-fg-subtle">{resource.mimeType}</p>
              )}
            </div>
            <Button
              variant="subtle"
              size="sm"
              className="shrink-0"
              loading={preview?.uri === resource.uri && preview.loading}
              onClick={() => void handlePreview(resource.uri)}
            >
              <Eye size={ICON_SM} />
              {s.preview}
            </Button>
          </div>

          {preview?.uri === resource.uri && !preview.loading && (
            <div className="rounded-sm bg-canvas px-3 py-2">
              {preview.error ? (
                <StatusNote tone="danger">{preview.error}</StatusNote>
              ) : (
                preview.response?.contents.map((content) => (
                  <div key={content.uri} className="space-y-1">
                    {content.text !== undefined ? (
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-fg">
                        {content.text}
                      </pre>
                    ) : (
                      <p className="text-xs text-fg-muted">
                        {s.binaryNotice.replace('{mime}', content.mimeType ?? 'binary')}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
