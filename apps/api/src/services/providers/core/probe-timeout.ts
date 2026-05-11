export const PROVIDER_PROBE_TIMEOUT_MS = 5_000;

export async function withAbortTimeout<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  timeoutMessage: string,
  timeoutMs = PROVIDER_PROBE_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await loader(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timeoutMessage, { cause: error });
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function withPromiseTimeout<T>(
  loader: () => Promise<T>,
  timeoutMessage: string,
  timeoutMs = PROVIDER_PROBE_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      loader(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
