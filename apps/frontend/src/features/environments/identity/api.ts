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

/**
 * Uploads an avatar image. Multipart, so it cannot ride on the update route —
 * the two are separate calls even when the dialog saves both at once.
 */
export async function uploadToolIdentityImage(
  subjectKey: string,
  image: File
): Promise<ToolIdentityUpdateResponse> {
  const { data, error } = await client.api['tool-identities']({ subjectKey }).image.post({ image });
  if (error) throwApiError(error);
  return data as ToolIdentityUpdateResponse;
}
