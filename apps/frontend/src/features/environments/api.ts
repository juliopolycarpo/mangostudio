/**
 * Environments API calls: forced re-probes and the install lifecycle.
 *
 * `prepare` and `start` can both come back blocked (403) or unavailable (409)
 * with the recipe attached. That is not an exception the UI swallows — it is the
 * payload `CopyCommandBlock` renders, so it is surfaced as a typed result rather
 * than a thrown error.
 */

import type {
  AgentCliStatus,
  InstallBlockedResponse,
  InstallCancelResponse,
  InstallPreparation,
  InstallRecipeId,
  InstallRecipePreview,
  InstallStartResponse,
  RecipeInput,
  RuntimeId,
  RuntimeStatus,
  VersionManagerId,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import type { LibraryTargetId } from '@mangostudio/shared/library';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export interface InstallRequest {
  readonly recipeId: InstallRecipeId;
  readonly input: RecipeInput;
  readonly preparationId?: string;
}

/** The recipe could not run; `recipe` carries the argv the user can copy instead. */
interface InstallRefusal {
  readonly outcome: 'refused';
  readonly recipe: InstallRecipePreview;
  readonly message: string;
}

export type InstallPrepareResult =
  | { readonly outcome: 'prepared'; readonly preparation: InstallPreparation }
  | InstallRefusal;

export type InstallStartResult =
  | { readonly outcome: 'started'; readonly run: InstallStartResponse }
  | InstallRefusal;

interface EdenErrorLike {
  readonly status?: number;
  readonly value?: unknown;
}

/**
 * Reads a refusal out of an Eden error. Only 403/409 responses that actually
 * carry a recipe qualify; anything else is a real failure and stays thrown.
 */
function toRefusal(error: EdenErrorLike): InstallRefusal | null {
  if (error.status !== 403 && error.status !== 409) return null;
  const value = error.value;
  if (!value || typeof value !== 'object' || !('recipe' in value)) return null;
  // The blocked body is `InstallBlockedResponseSchema`; the shared type is the
  // authority on its shape rather than a locally restated one.
  const blocked = value as Partial<InstallBlockedResponse>;
  if (!blocked.recipe) return null;
  return {
    outcome: 'refused',
    recipe: blocked.recipe,
    message: typeof blocked.error === 'string' ? blocked.error : '',
  };
}

export async function probeRuntime(id: RuntimeId): Promise<RuntimeStatus> {
  const { data, error } = await client.api.environments.runtimes({ id }).probe.post();
  if (error) throw new ApiError(error.value);
  return data as RuntimeStatus;
}

export async function probeVersionManager(id: VersionManagerId): Promise<VersionManagerStatus> {
  const { data, error } = await client.api.environments['version-managers']({ id }).probe.post();
  if (error) throw new ApiError(error.value);
  return data as VersionManagerStatus;
}

export async function probeAgentCli(targetId: LibraryTargetId): Promise<AgentCliStatus> {
  const { data, error } = await client.api.environments.agents({ targetId }).probe.post();
  if (error) throw new ApiError(error.value);
  return data as AgentCliStatus;
}

export async function prepareInstall(request: InstallRequest): Promise<InstallPrepareResult> {
  const { data, error } = await client.api.environments.install.prepare.post({
    recipeId: request.recipeId,
    input: request.input,
  });
  if (error) {
    const refusal = toRefusal(error);
    if (refusal) return refusal;
    throw new ApiError(error.value);
  }
  return { outcome: 'prepared', preparation: data as InstallPreparation };
}

export async function startInstall(request: InstallRequest): Promise<InstallStartResult> {
  const { data, error } = await client.api.environments.install.post({
    recipeId: request.recipeId,
    input: request.input,
    ...(request.preparationId && { preparationId: request.preparationId }),
  });
  if (error) {
    const refusal = toRefusal(error);
    if (refusal) return refusal;
    throw new ApiError(error.value);
  }
  return { outcome: 'started', run: data as InstallStartResponse };
}

export async function cancelInstall(runId: string): Promise<InstallCancelResponse> {
  const { data, error } = await client.api.environments.install({ runId }).cancel.post();
  if (error) throw new ApiError(error.value);
  return data as InstallCancelResponse;
}
