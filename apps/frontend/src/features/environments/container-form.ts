/**
 * Shared container form → config helpers for the add dialog and the card.
 *
 * Both surfaces edit the same shape, and the mount rules are the ones that
 * matter most: a host path that would hand the container the machine back is
 * refused by the API whatever the browser does, so the browser has to refuse it
 * beside the field that produced it rather than letting someone press Add and
 * read about it in a toast.
 *
 * The refusal sentences themselves come from shared, so the two sides cannot
 * disagree about what is allowed.
 */

import type {
  ContainerEngine,
  ContainerEnvironmentConfig,
  ContainerMount,
  ContainerMountRefusal,
} from '@mangostudio/shared/environments';
import { containerConfigRefusal } from '@mangostudio/shared/environments';

/** Mirrors `ContainerEnvironmentConfigSchema.image`; the server is the authority. */
const CONTAINER_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

export interface ContainerMountFields {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readonly: boolean;
}

export interface ContainerFormFields {
  readonly image: string;
  readonly engine: ContainerEngine;
  readonly network: boolean;
  readonly cpus: string;
  readonly memoryMib: string;
  readonly mounts: readonly ContainerMountFields[];
}

export function emptyContainerMount(): ContainerMountFields {
  return { hostPath: '', containerPath: '', readonly: false };
}

export function defaultContainerForm(engine: ContainerEngine = 'docker'): ContainerFormFields {
  return { image: '', engine, network: true, cpus: '', memoryMib: '', mounts: [] };
}

/** Reads a stored config back into form state, tolerating an unknown shape. */
export function containerConfigToForm(config: unknown): ContainerFormFields {
  const stored = (config ?? {}) as Partial<ContainerEnvironmentConfig>;
  return {
    image: typeof stored.image === 'string' ? stored.image : '',
    engine: stored.engine === 'podman' ? 'podman' : 'docker',
    network: stored.network !== false,
    cpus: typeof stored.cpus === 'number' ? String(stored.cpus) : '',
    memoryMib: typeof stored.memoryMib === 'number' ? String(stored.memoryMib) : '',
    mounts: Array.isArray(stored.mounts)
      ? stored.mounts.map((mount) => ({
          hostPath: typeof mount?.hostPath === 'string' ? mount.hostPath : '',
          containerPath: typeof mount?.containerPath === 'string' ? mount.containerPath : '',
          readonly: mount?.readonly === true,
        }))
      : [],
  };
}

/**
 * The form as the transport sees it.
 *
 * Defaults are omitted rather than written out: an environment that never
 * chose an engine should follow the default if it ever changes, and a stored
 * `network: true` would be a decision nobody made.
 */
export function containerFormToConfig(form: ContainerFormFields): ContainerEnvironmentConfig {
  const cpus = Number(form.cpus.trim());
  const memory = Number(form.memoryMib.trim());
  const mounts = usableMounts(form);
  return {
    image: form.image.trim(),
    ...(form.engine === 'docker' ? {} : { engine: form.engine }),
    ...(form.network ? {} : { network: false }),
    ...(form.cpus.trim() && Number.isFinite(cpus) && cpus > 0 ? { cpus } : {}),
    ...(form.memoryMib.trim() && Number.isInteger(memory) && memory > 0
      ? { memoryMib: memory }
      : {}),
    ...(mounts.length > 0 ? { mounts } : {}),
  };
}

/** Rows the user actually filled in. A blank row is an empty slot, not an error. */
function usableMounts(form: ContainerFormFields): ContainerMount[] {
  return form.mounts
    .filter((mount) => mount.hostPath.trim() || mount.containerPath.trim())
    .map((mount) => ({
      hostPath: mount.hostPath.trim(),
      containerPath: mount.containerPath.trim(),
      ...(mount.readonly ? { readonly: true } : {}),
    }));
}

/** Mirrors `ContainerEnvironmentConfigSchema.cpus`; the server is the authority. */
const CPU_LIMIT_MIN = 0.01;
const CPU_LIMIT_MAX = 1_024;

export interface ContainerFormError {
  readonly field: 'image' | 'cpus' | 'memoryMib' | 'mounts';
  /**
   * Why a mount was refused, as shared's code and its interpolation params.
   * Only mounts carry one: "not a valid image" is obvious beside an image box,
   * and "this would be a way out of the container" is not obvious beside
   * anything, so it needs a translated sentence built from this.
   */
  readonly refusal?: ContainerMountRefusal;
}

/**
 * The first thing wrong with the form, or null.
 *
 * Shapes are checked here; the mount policy is delegated to shared, which is
 * the same function the connector runs before it launches — so the browser
 * cannot come to a different conclusion than the thing that does the launching.
 */
export function validateContainerForm(form: ContainerFormFields): ContainerFormError | null {
  const image = form.image.trim();
  if (image.length === 0 || image.length > 256 || !CONTAINER_IMAGE_PATTERN.test(image)) {
    return { field: 'image' };
  }
  const cpus = form.cpus.trim();
  if (cpus && !(Number(cpus) >= CPU_LIMIT_MIN && Number(cpus) <= CPU_LIMIT_MAX)) {
    return { field: 'cpus' };
  }
  const memory = form.memoryMib.trim();
  if (memory && !(Number.isInteger(Number(memory)) && Number(memory) >= 64)) {
    return { field: 'memoryMib' };
  }

  // A row with one half filled in is a half-written mount, not a policy
  // problem, so it is caught before the shared rules run on it.
  const incomplete = usableMounts(form).some((mount) => !mount.hostPath || !mount.containerPath);
  if (incomplete) return { field: 'mounts' };

  const refusal = containerConfigRefusal(containerFormToConfig(form));
  return refusal ? { field: 'mounts', refusal } : null;
}

export function isContainerFormUsable(form: ContainerFormFields): boolean {
  return validateContainerForm(form) === null;
}
