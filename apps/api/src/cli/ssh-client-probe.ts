/**
 * Probes the system `ssh` client the hub launches SSH environments through.
 *
 * Doctor reports it because there is no fallback: SSH environments are the one
 * transport whose launcher is a program the hub does not ship. A Windows host
 * is the case worth naming — OpenSSH is an optional feature there, so a hub
 * that works in every other respect can still be unable to start one.
 */

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export interface SshClientProbe {
  /** Resolved executable, or null when nothing named `ssh` is on PATH. */
  readonly path: string | null;
  readonly version: string | null;
  readonly error: string | null;
}

export async function probeSshClient(
  path: string | null = Bun.which('ssh')
): Promise<SshClientProbe> {
  if (!path) return { path: null, version: null, error: null };

  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    child = Bun.spawn([path, '-V'], { stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    return { path, version: null, error: describeError(error) };
  }

  const timeout = setTimeout(() => child.kill(), VERSION_PROBE_TIMEOUT_MS);
  try {
    // OpenSSH prints its banner on stderr, and has since forever. Reading
    // stdout here would report a client that answered as one that said nothing.
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    const version = stderr.trim().split(/\r?\n/)[0]?.trim() ?? '';
    if (exitCode !== 0 && !version) {
      return { path, version: null, error: `exited with code ${exitCode}` };
    }
    return version
      ? { path, version, error: null }
      : { path, version: null, error: 'printed no version' };
  } catch (error) {
    return { path, version: null, error: describeError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
