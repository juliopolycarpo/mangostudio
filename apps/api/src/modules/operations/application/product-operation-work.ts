const activeWork = new Set<Promise<void>>();

/**
 * Keep a detached keyed turn under Hub ownership until execution and receipt settlement finish.
 * @example trackProductOperationWork(drainOperationStream(response, db, userId, operationId));
 */
export function trackProductOperationWork(work: Promise<void>): void {
  activeWork.add(work);
  void work.then(
    () => activeWork.delete(work),
    (error: unknown) => {
      activeWork.delete(work);
      console.error('[operations] Detached turn work failed', error);
    }
  );
}

/**
 * Wait for detached turns after HTTP admission and request handling have stopped.
 * @example await drainProductOperationWork();
 */
export async function drainProductOperationWork(): Promise<void> {
  await Promise.allSettled(activeWork);
}
