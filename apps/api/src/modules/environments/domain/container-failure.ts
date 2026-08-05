/**
 * Reads a container engine's output for the reason it refused.
 *
 * Same problem SSH has, for a different reason: `docker` and `podman` report a
 * missing binary, a daemon nobody started, an image that does not exist and an
 * image with no shell in it all as a nonzero exit and a line of English. The
 * exit status distinguishes none of them, and the fixes have nothing in common
 * — one is an install, one is `systemctl start`, one is a typo in a tag, one is
 * a different base image. So the reason is read out of stderr and travels to
 * the card as data.
 *
 * Every pattern here is matched against output both engines produce. Where they
 * word it differently, both spellings are listed rather than one being made
 * canonical: an unrecognised failure falls through to `unknown`, which keeps the
 * bounded stderr tail, and that is a better answer than a confident wrong one.
 */

import type { ContainerEngine, ContainerFailureReason } from '@mangostudio/shared/environments';

export interface ContainerFailureInput {
  readonly stderr: string;
  readonly exitCode: number | null;
  /** `code` of a spawn error, when the engine binary could not be started. */
  readonly spawnErrorCode?: string | undefined;
}

/**
 * Ordered because the signatures overlap. A daemon this hub may not talk to
 * says "permission denied", which also appears in registry refusals; asking
 * about the daemon first keeps "start Docker" from being reported as "check
 * your image name".
 */
const SIGNATURES: readonly { readonly reason: ContainerFailureReason; readonly match: RegExp }[] = [
  {
    reason: 'engine-unreachable',
    match:
      /cannot connect to the docker daemon|is the docker daemon running|permission denied while trying to connect|error during connect|cannot connect to podman|unable to connect to podman|connect: no such file or directory/i,
  },
  {
    // `sh` is what the probe runs; an image without one cannot be probed, and
    // the launch would fail the same way with the runtime as its entrypoint.
    reason: 'image-unsupported',
    match:
      /exec[^\n]*"?sh"?: executable file not found|starting container process caused[^\n]*exec|unable to start container process|no such file or directory: unknown/i,
  },
  {
    reason: 'image-missing',
    match:
      /no such image|image not known|manifest unknown|manifest for [^\s]+ not found|pull access denied|repository does not exist|requested access to the resource is denied|unauthorized: authentication required|not found: name unknown/i,
  },
  {
    reason: 'image-pull-failed',
    match:
      /toomanyrequests|rate limit|tls handshake timeout|i\/o timeout|dial tcp|temporary failure in name resolution|no route to host|context deadline exceeded|connection reset by peer/i,
  },
];

export function classifyContainerFailure(input: ContainerFailureInput): ContainerFailureReason {
  // A binary that is not on PATH never runs, so there is no output to read and
  // the spawn error is the whole account of it.
  if (input.spawnErrorCode === 'ENOENT') return 'engine-missing';

  const stderr = input.stderr;
  for (const { reason, match } of SIGNATURES) {
    if (match.test(stderr)) return reason;
  }
  return 'unknown';
}

/**
 * What to do about it, naming the engine so a machine with both installed says
 * which one refused.
 *
 * These are diagnostics on the connection status, not user-facing copy: the
 * card renders the translated sentence for the reason and uses this as the
 * detail beneath it, the same split the SSH failures use.
 */
export function describeContainerFailure(
  reason: ContainerFailureReason,
  context: { readonly engine: ContainerEngine; readonly image: string; readonly stderr: string }
): string {
  const { engine, image } = context;
  switch (reason) {
    case 'engine-missing':
      return `No ${engine} on this machine's PATH. Install it, or point this environment at the other engine.`;
    case 'engine-unreachable':
      return `${engine} is installed but did not answer. Start it, and make sure the account running MangoStudio may use it.`;
    case 'image-missing':
      return `${engine} could not find the image ${image}. Check the name and tag, and that this machine may pull from that registry.`;
    case 'image-pull-failed':
      return `Pulling ${image} did not finish. ${describeTail(context.stderr)}`;
    case 'image-unsupported':
      return `${image} has no shell, so MangoStudio cannot tell which runtime build it needs. Use an image that ships a shell.`;
    case 'runtime-unavailable':
      return `MangoStudio has no runtime build for the platform ${image} reports.`;
    case 'unknown':
      return `${engine} could not start a runtime in ${image}. ${describeTail(context.stderr)}`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function describeTail(stderr: string): string {
  const tail = stderr.trim();
  return tail ? `The engine reported:\n${tail}` : 'The engine reported nothing.';
}
