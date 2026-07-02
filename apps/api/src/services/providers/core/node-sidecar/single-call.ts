import { createInterface } from 'node:readline';
import {
  formatNodeSidecarExit,
  NodeSidecarError,
  type SpawnedNodeSidecarProcess,
  type SpawnNodeSidecarProcessOptions,
  spawnNodeSidecarProcess,
  terminateNodeSidecar,
  terminateNodeSidecarWithEscalation,
} from './spawn-sidecar';

export interface RequestNodeSidecarOptions<Response> {
  nodePath: string;
  sidecarScriptPath: string;
  request: unknown;
  timeoutMs: number;
  killGraceMs: number;
  sidecarLabel: string;
  isResponse: (value: Record<string, unknown>) => boolean;
  ignoreExitCodeWhen?: (response: Response) => boolean;
  envSource?: NodeJS.ProcessEnv;
  describeSpawnError?: SpawnNodeSidecarProcessOptions['describeSpawnError'];
}

async function readNodeSidecarResponse<Response>(
  sidecar: SpawnedNodeSidecarProcess,
  options: Pick<
    RequestNodeSidecarOptions<Response>,
    'isResponse' | 'ignoreExitCodeWhen' | 'sidecarLabel'
  >
): Promise<Response> {
  const rl = createInterface({ input: sidecar.child.stdout });
  let response: Response | undefined;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        continue;
      }

      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        options.isResponse(parsed as Record<string, unknown>)
      ) {
        response = parsed as Response;
        break;
      }
    }
  } catch (error) {
    throw new NodeSidecarError(
      error instanceof Error
        ? error.message
        : `Failed to read the ${options.sidecarLabel} sidecar response.`
    );
  } finally {
    rl.close();
  }

  const exitStatus = await sidecar.childExit;
  const spawnErrorMessage = sidecar.getSpawnErrorMessage();
  if (spawnErrorMessage) {
    throw new NodeSidecarError(spawnErrorMessage);
  }

  if (!response) {
    throw new NodeSidecarError(
      sidecar.getStderr().trim() || formatNodeSidecarExit(exitStatus, options.sidecarLabel)
    );
  }

  if (!options.ignoreExitCodeWhen?.(response) && exitStatus.code !== 0) {
    throw new NodeSidecarError(
      sidecar.getStderr().trim() || formatNodeSidecarExit(exitStatus, options.sidecarLabel)
    );
  }

  return response;
}

export async function requestNodeSidecar<Response>(
  options: RequestNodeSidecarOptions<Response>
): Promise<Response> {
  const sidecar = spawnNodeSidecarProcess({
    nodePath: options.nodePath,
    sidecarScriptPath: options.sidecarScriptPath,
    envSource: options.envSource,
    describeSpawnError: options.describeSpawnError,
  });
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const responsePromise = readNodeSidecarResponse(sidecar, options);
  responsePromise.catch(() => undefined);

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      terminateNodeSidecar(sidecar.child);
      reject(
        new NodeSidecarError(
          `${options.sidecarLabel} sidecar request timed out after ${options.timeoutMs}ms.`
        )
      );
    }, options.timeoutMs);
    timeout.unref?.();
  });

  try {
    sidecar.child.stdin.write(`${JSON.stringify(options.request)}\n`);
    sidecar.child.stdin.end();

    return await Promise.race([responsePromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (timedOut) {
      await terminateNodeSidecarWithEscalation(
        sidecar.child,
        sidecar.childExit,
        options.killGraceMs
      );
    } else {
      terminateNodeSidecar(sidecar.child);
    }
  }
}
