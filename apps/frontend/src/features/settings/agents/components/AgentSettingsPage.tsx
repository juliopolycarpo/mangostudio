import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared';
import type {
  AgentProfile,
  AgentProfileUpsertBody,
  CreateAgentProfileBody,
  UserAgentId,
} from '@mangostudio/shared/agents';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { useModelCatalog } from '@/hooks/use-model-catalog';
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
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { SettingsSectionHeader } from './SettingsSectionHeader';

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

  const invalidateAgents = async () => {
    await queryClient.invalidateQueries({ queryKey: agentSettingsKeys.list() });
  };

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
      toast(error instanceof Error ? error.message : labels.saveError, 'error');
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
      toast(error instanceof Error ? error.message : labels.previewError, 'error');
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
      toast(error instanceof Error ? error.message : labels.deleteError, 'error');
    },
  });

  if (agentsQuery.isLoading || toolsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-on-surface-variant">{t.common.loading}</p>
      </div>
    );
  }

  if (agentsQuery.error || toolsQuery.error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-destructive">{labels.loadError}</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void agentsQuery.refetch();
            void toolsQuery.refetch();
          }}
        >
          {labels.retry}
        </Button>
      </div>
    );
  }

  if (agents.length === 0 && !newAgent) {
    return (
      <div className="space-y-6">
        <AgentSettingsHeader labels={labels} onCreate={handleCreateAgent} />

        <Card variant="solid" className="p-8 sm:p-12 text-center space-y-4">
          <div className="p-4 bg-surface-container-high rounded-full w-fit mx-auto text-on-surface-variant/40">
            <Bot size={32} />
          </div>
          <div className="space-y-1">
            <p className="text-on-surface font-bold">{labels.emptyStateTitle}</p>
            <p className="text-sm text-on-surface-variant/60">{labels.emptyStateDescription}</p>
          </div>
          <Button variant="primary" onClick={handleCreateAgent}>
            <Plus size={16} />
            {labels.create}
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AgentSettingsHeader labels={labels} onCreate={handleCreateAgent} />

      <AgentList
        agents={newAgent ? [newAgent, ...agents] : agents}
        selectedAgentId={selectedAgent?.id ?? null}
        builtInLabel={labels.builtIn}
        userLabel={labels.user}
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
          labels={{
            builtIn: labels.builtIn,
            user: labels.user,
            createTitle: labels.createTitle,
            name: labels.name,
            slug: labels.slug,
            description: labels.agentDescription,
            role: labels.role,
            roles: labels.roles,
            systemPrompt: labels.systemPrompt,
            model: labels.model,
            modelDefaultOption: labels.modelDefaultOption,
            thinking: labels.thinking,
            reasoningEffort: labels.reasoningEffort,
            reasoningEfforts: labels.reasoningEfforts,
            maxToolIterations: labels.maxToolIterations,
            toolsEnabled: labels.toolsEnabled,
            toolAllowlist: labels.toolAllowlist,
            noTools: labels.noTools,
            subagents: labels.subagents,
            noSubagents: labels.noSubagents,
            path: labels.path,
            friendlyMode: labels.friendlyMode,
            rawMode: labels.rawMode,
            rawMarkdown: labels.rawMarkdown,
            preview: labels.preview,
            previewing: labels.previewing,
            save: labels.save,
            saving: labels.saving,
            reset: labels.reset,
            delete: labels.delete,
            sectionIdentity: labels.sectionIdentity,
            sectionBehavior: labels.sectionBehavior,
            sectionReasoning: labels.sectionReasoning,
            sectionTools: labels.sectionTools,
            unsavedChanges: labels.unsavedChanges,
            confirmResetTitle: labels.confirmResetTitle,
            confirmResetDescription: labels.confirmResetDescription,
            confirmReset: labels.confirmReset,
            cancel: labels.cancel,
          }}
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

      <DeleteAgentDialog
        title={labels.deleteTitle}
        description={labels.deleteDescription}
        cancelLabel={labels.cancel}
        confirmLabel={labels.deleteConfirm}
        deletingLabel={labels.deleting}
        isOpen={agentPendingDelete !== null}
        isDeleting={deleteMutation.isPending}
        onCancel={() => setAgentPendingDelete(null)}
        onConfirm={() => {
          if (agentPendingDelete) deleteMutation.mutate(agentPendingDelete.id);
        }}
      />
    </div>
  );
}

interface AgentHeaderLabels {
  readonly title: string;
  readonly description: string;
  readonly create: string;
}

interface AgentSettingsHeaderProps {
  readonly labels: AgentHeaderLabels;
  readonly onCreate: () => void;
}

function AgentSettingsHeader({ labels, onCreate }: AgentSettingsHeaderProps) {
  return (
    <SettingsSectionHeader
      title={labels.title}
      description={labels.description}
      icon={<Bot size={22} />}
      action={
        <Button type="button" variant="secondary" onClick={onCreate}>
          <Plus size={16} />
          {labels.create}
        </Button>
      }
    />
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
