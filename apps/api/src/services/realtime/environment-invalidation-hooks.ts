type EnvironmentInvalidationListener = (userId: string) => void;

const listeners = new Set<EnvironmentInvalidationListener>();

/** In-process cache hooks that run beside the user-facing realtime event. */
export function onEnvironmentInvalidation(listener: EnvironmentInvalidationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyEnvironmentInvalidation(userId: string): void {
  for (const listener of [...listeners]) listener(userId);
}
