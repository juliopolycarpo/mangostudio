import type {
  AgentMarkdownPreviewBody,
  AgentMarkdownPreviewResponse,
  AgentProfile,
  AgentProfileUpsertBody,
  CreateAgentProfileBody,
  DeleteAgentProfileResponse,
} from '@mangostudio/shared/agents';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function updateAgentProfile(
  agentId: string,
  body: AgentProfileUpsertBody
): Promise<AgentProfile> {
  const { data, error } = await client.api.settings
    .agents({ agentId })
    .put(toMutableAgentBody(body));
  if (error) throw new Error(extractApiError(error.value));
  return data as AgentProfile;
}

export async function createAgentProfile(body: CreateAgentProfileBody): Promise<AgentProfile> {
  const { data, error } = await client.api.settings.agents.post({
    ...toMutableAgentBody(body),
    ...(body.slug ? { slug: body.slug } : {}),
  });
  if (error) throw new Error(extractApiError(error.value));
  return data as AgentProfile;
}

export async function deleteAgentProfile(agentId: string): Promise<DeleteAgentProfileResponse> {
  const { data, error } = await client.api.settings.agents({ agentId }).delete();
  if (error) throw new Error(extractApiError(error.value));
  return data as DeleteAgentProfileResponse;
}

export async function previewAgentMarkdown(
  body: AgentMarkdownPreviewBody
): Promise<AgentMarkdownPreviewResponse> {
  const { data, error } = await client.api.settings.agents.preview.post(body);
  if (error) throw new Error(extractApiError(error.value));
  return data as AgentMarkdownPreviewResponse;
}

function toMutableAgentBody(body: AgentProfileUpsertBody) {
  return {
    ...body,
    toolNames: [...body.toolNames],
    subagentIds: [...body.subagentIds],
  };
}
