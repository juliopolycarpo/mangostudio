/**
 * Per-server resource browser: lists the resources the server advertises and
 * previews a resource's text content inline on demand. Servers without the
 * resources capability get a quiet notice instead of an error.
 */

import type { McpServer, ReadMcpResourceResponse } from '@mangostudio/shared/mcp';
import { useQuery } from '@tanstack/react-query';
import { Eye, FileText } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
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
    return <p className="text-sm text-on-surface-variant py-2">{t.common.loading}</p>;
  }
  if (resourcesQuery.error) {
    return <p className="text-sm text-error py-2">{s.loadError}</p>;
  }
  if (resourcesQuery.data === null) {
    return <p className="text-sm text-on-surface-variant/60 py-2">{s.notSupported}</p>;
  }

  const resources = resourcesQuery.data?.resources ?? [];
  if (resources.length === 0) {
    return <p className="text-sm text-on-surface-variant/60 py-2">{s.empty}</p>;
  }

  return (
    <ul className="space-y-2 py-2">
      {resources.map((resource) => (
        <li
          key={resource.uri}
          className="rounded-xl bg-surface-container-lowest/60 px-3 py-2 space-y-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <p className="flex items-center gap-1.5 text-sm font-medium text-on-surface break-all">
                <FileText size={13} className="shrink-0 text-primary/70" />
                {resource.name}
              </p>
              <p className="text-xs text-on-surface-variant/70 break-all">{resource.uri}</p>
              {resource.description && (
                <p className="text-xs text-on-surface-variant/70 leading-relaxed">
                  {resource.description}
                </p>
              )}
              {resource.mimeType && (
                <p className="text-[10px] font-mono text-on-surface-variant/50">
                  {resource.mimeType}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              loading={preview?.uri === resource.uri && preview.loading}
              onClick={() => void handlePreview(resource.uri)}
            >
              <Eye size={13} />
              <span className="ml-1">{s.preview}</span>
            </Button>
          </div>

          {preview?.uri === resource.uri && !preview.loading && (
            <div className="rounded-lg bg-surface-container-high/60 px-3 py-2">
              {preview.error ? (
                <p className="text-xs text-error">{preview.error}</p>
              ) : (
                preview.response?.contents.map((content) => (
                  <div key={content.uri} className="space-y-1">
                    {content.text !== undefined ? (
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-on-surface-variant font-mono">
                        {content.text}
                      </pre>
                    ) : (
                      <p className="text-xs text-on-surface-variant/70">
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
