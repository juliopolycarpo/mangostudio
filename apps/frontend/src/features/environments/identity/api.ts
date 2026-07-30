import type {
  ToolIdentityUpdate,
  ToolIdentityUpdateResponse,
} from '@mangostudio/shared/tool-identity';
import { client } from '@/lib/api-client';
import { throwApiError } from '@/lib/utils';

export async function updateToolIdentity(
  subjectKey: string,
  body: ToolIdentityUpdate
): Promise<ToolIdentityUpdateResponse> {
  const { data, error } = await client.api['tool-identities']({ subjectKey }).put(body);
  if (error) throwApiError(error);
  return data as ToolIdentityUpdateResponse;
}

export async function resetToolIdentity(subjectKey: string): Promise<void> {
  const { error } = await client.api['tool-identities']({ subjectKey }).delete();
  if (error) throwApiError(error);
}
