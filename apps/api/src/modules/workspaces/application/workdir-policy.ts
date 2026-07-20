import type { WorkdirPolicy } from '../../../services/tools/types';

export function resolveEffectiveRestrictToolsToWorkdir(
  globalDefault: boolean,
  chatOverride: boolean | null | undefined
): boolean {
  if (chatOverride === true || chatOverride === false) {
    return chatOverride;
  }
  return globalDefault;
}

export function buildWorkdirPolicy(
  workdir: string | undefined,
  restricted: boolean
): WorkdirPolicy | undefined {
  if (!workdir || !restricted) {
    return undefined;
  }
  return { root: workdir, restricted: true };
}
