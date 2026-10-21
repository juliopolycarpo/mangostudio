import type {
  AgentProfile,
  AgentProfileUpsertBody,
  CreateAgentProfileBody,
  UserAgentId,
} from '@mangostudio/shared/agents';
import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared/catalog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsLoadError, SettingsLoading } from '@/components/settings/SettingsStates';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { useModelCatalog } from '@/hooks/use-model-catalog';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { toolSettingsListQueryOptions } from '../../tools/queries';
import {
  createAgentProfile,
  deleteAgentProfile,
  previewAgentMarkdown,
  updateAgentProfile,
} from '../api';
import { agentSettingsKeys, agentSettingsListQueryOptions } from '../queries';
import { AgentEditor, type EditableAgentProfile } from './AgentEditor';
import { AgentList } from './AgentList';

const NEW_AGENT_ID = 'user:new-agent' as const;

export function AgentSettingsPage() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const labels = t.settings.agents;
  const agentsQuery = useQuery(agentSettingsListQueryOptions());
  const toolsQuery = useQuery(toolSettingsListQueryOptions());
  const modelCatalogQuery = useModelCatalog();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState<EditableAgentProfile | null>(null);
  const [agentPendingDelete, setAgentPendingDelete] = useState<AgentProfile | null>(null);

  const agents = useMemo(() => agentsQuery.data?.agents ?? [], [agentsQuery.data?.agents]);
  const modelOptions = useMemo(
    () => buildAgentModelOptions(modelCatalogQuery.catalog),
    [modelCatalogQuery.catalog]
  );
  const selectedAgent = useMemo(() => {
    if (newAgent) return newAgent;
    return agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;
  }, [agents, newAgent, selectedAgentId]);

  const handleCreateAgent = () => {
    const draft = createNewAgent(labels.newAgentName, labels.newAgentDescription);
    setNewAgent(draft);
    setSelectedAgentId(draft.id);
  };

  const invalidateAgents = () =>
    queryClient.invalidateQueries({ queryKey: agentSettingsKeys.list() });

  const saveMutation = useMutation({
    // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
    mutationFn: async ({ agent, body }: SaveAgentInput) => {
      if (agent.kind === 'user' && agent.id === NEW_AGENT_ID) {
        const createBody: CreateAgentProfileBody = {
          ...body,
          ...(agent.slug ? { slug: agent.slug } : {}),
        };
        return createAgentProfile(createBody);
      }
      return updateAgentProfile(agent.id, body);
    },
    onSuccess: async (agent) => {
      setNewAgent(null);
      setSelectedAgentId(agent.id);
      await invalidateAgents();
      toast(labels.saved, 'success');
    },
    onError: (error) => {
      toast(resolveApiErrorMessage(error, labels.saveError), 'error');
    },
  });

  const previewMutation = useMutation({
    mutationFn: ({ markdown, agentId }: PreviewMarkdownInput) =>
      previewAgentMarkdown({
        markdown,
        id: agentId.startsWith('user:') ? (agentId as UserAgentId) : undefined,
      }),
    onSuccess: () => {
      toast(labels.previewed, 'success');
    },
    onError: (error) => {
      toast(resolveApiErrorMessage(error, labels.previewError), 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (agentId: string) => deleteAgentProfile(agentId),
    onSuccess: async () => {
      setAgentPendingDelete(null);
      setSelectedAgentId(null);
      await invalidateAgents();
      toast(labels.deleted, 'success');
    },
    onError: (error) => {
      toast(resolveApiErrorMessage(error, labels.deleteError), 'error');
    },
  });

  const page = { title: labels.title, description: labels.description };

  if (agentsQuery.isLoading || toolsQuery.isLoading) {
    return (
      <SettingsPage {...page}>
        <SettingsLoading shape="card" count={2} />
      </SettingsPage>
    );
  }

  if (agentsQuery.error || toolsQuery.error) {
    return (
      <SettingsPage {...page}>
        <SettingsLoadError
          message={labels.loadError}
          onRetry={() => {
            void agentsQuery.refetch();
            void toolsQuery.refetch();
          }}
        />
      </SettingsPage>
    );
  }

  const createAction = (
    <Button type="button" variant="secondary" size="sm" onClick={handleCreateAgent}>
      <Plus size={ICON_SM} />
      {labels.create}
    </Button>
  );

  if (agents.length === 0 && !newAgent) {
    return (
      // The empty state's own action is the way in, so the header does not
      // draw a second "Create agent" beside it (patterns.md, Empty).
      <SettingsPage {...page}>
        <Card padded={false}>
          <EmptyState
            icon={<Bot size={ICON_LG} />}
            title={labels.emptyStateTitle}
            hint={labels.emptyStateDescription}
            action={createAction}
          />
        </Card>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage {...page} actions={createAction}>
      <AgentList
        agents={newAgent ? [newAgent, ...agents] : agents}
        selectedAgentId={selectedAgent?.id ?? null}
        ariaLabel={labels.title}
        builtInAgentsTitle={labels.builtInAgents}
        userAgentsTitle={labels.userAgents}
        onSelect={(agentId) => {
          if (agentId !== NEW_AGENT_ID) setNewAgent(null);
          setSelectedAgentId(agentId);
        }}
      />

      {selectedAgent && (
        <AgentEditor
          key={selectedAgent.id}
          agent={selectedAgent}
          allAgents={agents}
          tools={toolsQuery.data?.tools ?? []}
          modelOptions={modelOptions}
          labels={labels}
          isNew={selectedAgent.id === NEW_AGENT_ID}
          isSaving={saveMutation.isPending}
          isPreviewing={previewMutation.isPending}
          onSave={(agent, body) => saveMutation.mutate({ agent, body })}
          onPreviewMarkdown={async (markdown, agentId) => {
            const preview = await previewMutation.mutateAsync({
              markdown,
              agentId: agentId,
            });
            return preview.profile;
          }}
          onDelete={setAgentPendingDelete}
          onCancelNew={() => setNewAgent(null)}
        />
      )}

      {agentPendingDelete && (
        <ConfirmDialog
          title={labels.deleteTitle}
          description={labels.deleteDescription}
          entityName={agentPendingDelete.name}
          confirmLabel={labels.deleteConfirm}
          cancelLabel={labels.cancel}
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(agentPendingDelete.id)}
          onCancel={() => setAgentPendingDelete(null)}
        />
      )}
    </SettingsPage>
  );
}

interface SaveAgentInput {
  readonly agent: EditableAgentProfile;
  readonly body: AgentProfileUpsertBody;
}

interface PreviewMarkdownInput {
  readonly markdown: string;
  readonly agentId: string;
}

function createNewAgent(name: string, description: string): EditableAgentProfile {
  return {
    id: NEW_AGENT_ID,
    name,
    description,
    kind: 'user',
    role: 'primary',
    source: { type: 'markdown' },
    systemPrompt: '',
    toolNames: [],
    toolsEnabled: true,
    subagentIds: [],
    metadata: {},
    slug: '',
  };
}

function buildAgentModelOptions(catalog: ModelCatalogResponse) {
  const source = catalog.textModels.length > 0 ? catalog.textModels : catalog.allModels;
  const byId = new Map<string, ModelOption>();
  for (const option of source) {
    if (!byId.has(option.modelId)) byId.set(option.modelId, option);
  }

  return Array.from(byId.values())
    .sort((a, b) => {
      const providerCmp = String(a.provider ?? '').localeCompare(String(b.provider ?? ''));
      if (providerCmp !== 0) return providerCmp;
      return a.displayName.localeCompare(b.displayName);
    })
    .map((option) => {
      const label =
        option.displayName && option.displayName !== option.modelId
          ? `${option.displayName} (${option.modelId})`
          : option.modelId;
      return { value: option.modelId, label };
    });
}
