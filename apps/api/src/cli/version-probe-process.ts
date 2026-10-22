import type { ReadableStreamDefaultReader } from 'node:stream/web';

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export interface VersionProbeProcess {
  readonly exited: Promise<number>;
  kill(signal?: 'SIGKILL'): void;
}

/**
 * Owns a version process and its output through exit or the five-second deadline.
 *
 * @example
 * const { text, exitCode } = await readVersionProcess(child, child.stdout, 'runtime --version');
 */
export async function readVersionProcess(
  child: VersionProbeProcess,
  output: ReadableStream<Uint8Array>,
  command: string
): Promise<{ text: string; exitCode: number }> {
  const reader = output.getReader();
  let timedOut = false;
  let stopFailure: string | undefined;
  let cancellation: Promise<void> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch (error) {
      stopFailure = String(error);
    }
    // A descendant can retain the output pipe after the root exits. Cancel our read as well
    // as killing the child, so that inherited pipe cannot strand the caller.
    cancellation = reader.cancel();
    void cancellation.catch(() => undefined);
  }, VERSION_PROBE_TIMEOUT_MS);
  try {
    const reading = readProbeOutput(reader).catch((error) => {
      try {
        child.kill('SIGKILL');
      } catch (stopError) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; failed to stop process: ${String(stopError)}`);
      }
      throw error;
    });
    // Retain ownership until both the pipe and the process have settled,
    // including after a read error or a deadline-triggered kill.
    const [text, exited] = await Promise.allSettled([reading, child.exited]);
    if (timedOut) {
      const detail = stopFailure ? `; failed to stop process: ${stopFailure}` : '';
      throw new Error(`${command} timed out after ${VERSION_PROBE_TIMEOUT_MS} ms${detail}`);
    }
    if (text.status === 'rejected') throw text.reason;
    if (exited.status === 'rejected') throw exited.reason;
    return { text: text.value, exitCode: exited.value };
  } finally {
    clearTimeout(timeout);
    await cancellation?.catch(() => undefined);
    reader.releaseLock();
  }
}

async function readProbeOutput(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read'>
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}
