/**
 * How the hub starts a runtime inside a container.
 *
 * A launcher, not a seventh protocol: what comes out of here is fed to the same
 * stdio spawn every other hub-started runtime uses, which appends its own
 * `--stdio` — that lands as the entrypoint's argument because everything after
 * the image on a `run` command line is the container's argv.
 *
 * Nothing is ever baked into an image. The runtime binary is bind-mounted
 * read-only at launch, so the version inside the container follows the hub's
 * and an upgrade needs no image rebuild. The image itself is the user's.
 *
 * The builders live in shared for the same reason the SSH ones do: the hub
 * spawns this argv and the browser has to describe it truthfully, and a second
 * copy of the flag list would drift the moment one of them changed.
 */

import type { ContainerEngine, ContainerEnvironmentConfig, ContainerMount } from './schemas';
import { CONTAINER_MAX_MOUNTS } from './schemas';

export interface ContainerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Where the runtime binary is mounted inside the container.
 *
 * Under `/opt` rather than `/usr/local/bin` so it cannot collide with a package
 * the image installed, and as a file rather than a directory so the mount
 * cannot shadow anything the image put beside it.
 */
export const CONTAINER_RUNTIME_MOUNT_PATH = '/opt/mangostudio-runtime';

/** Prefix for every container this hub starts, so its own are recognisable. */
export const CONTAINER_NAME_PREFIX = 'mango-rt';

/** Default when a config does not name one. */
export const DEFAULT_CONTAINER_ENGINE: ContainerEngine = 'docker';

/**
 * Host paths that would hand the agent the machine the sandbox exists to keep
 * it off.
 *
 * A container is isolation against a mistake, not against an adversary, and
 * these are the mounts that remove even that. The engine's own socket is the
 * sharpest: a process that can reach it can start a second container with the
 * host's root filesystem mounted, which is a complete escape from a one-line
 * config change. `/proc` and `/sys` expose the host's kernel state, and
 * `/var/run` (and `/run`, which it is a symlink to on every modern distribution)
 * is where the socket usually lives.
 *
 * Enforced, not documented: 026's own risk note is that container isolation is
 * strong rather than absolute, and this is the difference between the two.
 */
const DENIED_HOST_PATH_PREFIXES: readonly string[] = ['/proc', '/sys', '/var/run', '/run'];

/** Socket basenames refused wherever they live, including a user's rootless path. */
const DENIED_HOST_PATH_BASENAMES: readonly string[] = ['docker.sock', 'podman.sock'];

/** `C:` or `c:/…` — the one colon the engines parse for themselves. */
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

export function containerEngineOf(config: ContainerEnvironmentConfig): ContainerEngine {
  return config.engine ?? DEFAULT_CONTAINER_ENGINE;
}

/**
 * The name this launch's container carries.
 *
 * It exists so the kill backstop has something to aim at that is not the image:
 * two environments may run the same image, and killing by image would take down
 * a chat that has nothing to do with this one. The nonce keeps a relaunch from
 * colliding with a container the engine has not finished reaping.
 */
export function containerName(environmentId: string, nonce: string): string {
  return `${CONTAINER_NAME_PREFIX}-${environmentId}-${nonce}`;
}

/**
 * Every distinct reason {@link containerConfigRefusal} can give, as a code a
 * caller can map to its own translated copy instead of quoting English back.
 */
export type ContainerMountRefusalCode =
  | 'too-many-mounts'
  | 'whitespace'
  | 'not-absolute'
  | 'contains-colon'
  | 'engine-control'
  | 'denied-prefix'
  | 'host-root'
  | 'shadows-runtime'
  | 'shadows-image-root'
  | 'duplicate-target';

/** A refusal reason plus whatever it needs interpolated into its sentence. */
export interface ContainerMountRefusal {
  readonly code: ContainerMountRefusalCode;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Whether this config can be launched at all, as a structured refusal, or
 * null when it can.
 *
 * The schema settles shapes — an absolute container path, a bounded mount
 * count, an image that cannot start with a dash. What is left is the part a
 * JSON schema cannot say: that a host path is absolute in either style, that it
 * is not one of the paths that would undo the isolation, and that two mounts do
 * not land on the same target.
 *
 * The result is a code, not a sentence: the hub logs it through
 * {@link describeContainerMountRefusal}, and the browser owns its own
 * translated copy per code instead of rendering whichever language this ran in.
 */
export function containerConfigRefusal(
  config: ContainerEnvironmentConfig
): ContainerMountRefusal | null {
  const mounts = config.mounts ?? [];
  if (mounts.length > CONTAINER_MAX_MOUNTS) {
    return { code: 'too-many-mounts', params: { max: String(CONTAINER_MAX_MOUNTS) } };
  }

  const targets = new Set<string>();
  for (const mount of mounts) {
    const refusal = mountRefusal(mount);
    if (refusal) return refusal;
    const target = normalizeContainerTarget(mount.containerPath);
    if (targets.has(target)) {
      return { code: 'duplicate-target', params: { containerPath: mount.containerPath } };
    }
    targets.add(target);
  }
  return null;
}

/** English sentence for a refusal — what the hub logs and reports on launch failure. */
export function describeContainerMountRefusal(refusal: ContainerMountRefusal): string {
  const { host, prefix, containerPath, runtimePath, max } = refusal.params;
  switch (refusal.code) {
    case 'too-many-mounts':
      return `An environment may mount at most ${max} paths into its container.`;
    case 'whitespace':
      return `The host path ${host} has leading or trailing whitespace.`;
    case 'not-absolute':
      return `The host path ${host} is not absolute. A relative path would be resolved against whatever directory the container engine inherited.`;
    case 'contains-colon':
      return `The host path ${host} contains a colon, which separates the fields of a mount specification.`;
    case 'engine-control':
      return `Mounting ${host} would give the container control of the container engine, which is a way out of the container.`;
    case 'denied-prefix':
      return `Mounting ${host} would expose this machine's ${prefix}, which is a way out of the container.`;
    case 'host-root':
      return `Mounting ${host} would expose this machine's entire filesystem, which is a way out of the container.`;
    case 'shadows-runtime':
      return `${runtimePath} is where the MangoStudio runtime is mounted. Choose another path inside the container.`;
    case 'shadows-image-root':
      return 'Mounting over / would replace the image the container is built from.';
    case 'duplicate-target':
      return `Two mounts both target ${containerPath} inside the container. Give each one its own path.`;
  }
}

/** Without a trailing slash, so `/work` and `/work/` collide as the same target. */
function normalizeContainerTarget(containerPath: string): string {
  return containerPath.length > 1 && containerPath.endsWith('/')
    ? containerPath.slice(0, -1)
    : containerPath;
}

function mountRefusal(mount: ContainerMount): ContainerMountRefusal | null {
  const host = mount.hostPath.trim();
  if (host !== mount.hostPath) {
    return { code: 'whitespace', params: { host: mount.hostPath } };
  }
  const windowsStyle = WINDOWS_DRIVE_PREFIX.test(host);
  if (!(host.startsWith('/') || windowsStyle)) {
    return { code: 'not-absolute', params: { host } };
  }
  // `-v` splits on colons, so one inside a path silently becomes a field
  // boundary and mounts something nobody asked for. A Windows drive letter is
  // the documented exception both engines parse themselves.
  const rest = windowsStyle ? host.slice(2) : host;
  if (rest.includes(':')) {
    return { code: 'contains-colon', params: { host } };
  }

  const resolved = collapseTraversal(normalizeHostPath(host));
  if (DENIED_HOST_PATH_BASENAMES.some((name) => resolved.endsWith(`/${name}`))) {
    return { code: 'engine-control', params: { host } };
  }
  const denied = DENIED_HOST_PATH_PREFIXES.find(
    (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`)
  );
  if (denied) {
    return { code: 'denied-prefix', params: { host, prefix: denied } };
  }
  if (isHostRoot(resolved)) {
    return { code: 'host-root', params: { host } };
  }

  // The runtime's own mount lands here; a user mount on the same path would
  // shadow the binary the container is started to run.
  if (
    mount.containerPath === CONTAINER_RUNTIME_MOUNT_PATH ||
    mount.containerPath.startsWith(`${CONTAINER_RUNTIME_MOUNT_PATH}/`)
  ) {
    return { code: 'shadows-runtime', params: { runtimePath: CONTAINER_RUNTIME_MOUNT_PATH } };
  }
  if (mount.containerPath === '/') {
    return { code: 'shadows-image-root', params: {} };
  }
  return null;
}

/** Lower-cased, forward-slashed, and without a trailing slash, for comparison. */
function normalizeHostPath(host: string): string {
  const forward = host.replaceAll('\\', '/').toLowerCase();
  // A bare drive root ("c:/") keeps its slash: stripping it would leave "c:",
  // which no longer matches WINDOWS_DRIVE_PREFIX, so collapseTraversal below
  // would stop treating it as a drive and misparse it as a relative segment.
  if (/^[a-z]:\/$/.test(forward)) return forward;
  return forward.length > 1 && forward.endsWith('/') ? forward.slice(0, -1) : forward;
}

/**
 * Collapses `.` and `..` segments lexically, without touching the filesystem.
 *
 * The denylist below is a string prefix check, and a prefix check does not
 * know that `/tmp/../proc` and `/proc` name the same directory. This is what
 * lets it see that they do, so a traversal cannot spell its way past a denied
 * prefix.
 */
function collapseTraversal(normalized: string): string {
  const windowsStyle = WINDOWS_DRIVE_PREFIX.test(normalized);
  const anchor = windowsStyle ? normalized.slice(0, 2) : '';
  const rest = windowsStyle ? normalized.slice(2) : normalized;
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `${anchor}/${segments.join('/')}`;
}

/** Whether a resolved path names the top of its filesystem (or drive). */
function isHostRoot(resolved: string): boolean {
  return resolved === '/' || /^[a-z]:\/$/.test(resolved);
}

/**
 * Whether the engine holds this image already. Cheap, local, and the thing that
 * decides whether a pull has to be reported as its own phase.
 */
export function containerImageInspectCommand(config: ContainerEnvironmentConfig): ContainerCommand {
  return {
    command: containerEngineOf(config),
    args: ['image', 'inspect', '--format', '{{.Id}}', config.image],
  };
}

/** Fetches the image. Long-running by nature; the caller reports it as a phase. */
export function containerPullCommand(config: ContainerEnvironmentConfig): ContainerCommand {
  return { command: containerEngineOf(config), args: ['pull', config.image] };
}

/** Asks the engine for its version, which is also how availability is decided. */
export function containerEngineVersionCommand(engine: ContainerEngine): ContainerCommand {
  return { command: engine, args: ['version', '--format', '{{.Client.Version}}'] };
}

/**
 * Runs one command inside the image to find out which runtime build it needs.
 *
 * No network and no mounts: this answers a question about the image, so it gets
 * nothing the answer does not require. `--pull=never` keeps it from becoming an
 * accidental download — the pull is a separate, visible step.
 *
 * An image with no shell fails here rather than at launch, which is the whole
 * point of probing: "use a shell-bearing image" is an answer, and a runtime
 * that never handshakes is not.
 *
 * `name`, when given, is what a caller kills the probe by if it has to give up
 * on it: `execFile`'s own timeout only kills the CLI, and the daemon-owned
 * container it started keeps running past that.
 */
export function containerProbeCommand(
  config: ContainerEnvironmentConfig,
  script: string,
  name?: string
): ContainerCommand {
  return {
    command: containerEngineOf(config),
    args: [
      'run',
      '--rm',
      ...(name === undefined ? [] : ['--name', name]),
      '--pull=never',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      config.image,
      '-c',
      script,
    ],
  };
}

/** Stops a container by the name this hub gave it. The teardown backstop. */
export function containerKillCommand(engine: ContainerEngine, name: string): ContainerCommand {
  return { command: engine, args: ['kill', name] };
}

export interface ContainerLaunchParams {
  readonly config: ContainerEnvironmentConfig;
  /** From {@link containerName}; the backstop kills exactly this. */
  readonly name: string;
  /** Host path of the runtime binary matching the image's platform. */
  readonly runtimeBinaryPath: string;
}

/**
 * argv that starts a runtime inside a container.
 *
 * Every value is a discrete argv entry and nothing is interpolated into a
 * command string — the same discipline the SSH launcher keeps, for the same
 * reason: an image or a path that starts with a dash would otherwise be read as
 * an option to the engine.
 *
 * `--rm` and stdin closing are the normal teardown. `--init` puts a real init
 * at PID 1 so a shell tool's grandchildren are reaped instead of accumulating
 * inside a long-lived chat. `--pull=never` is what keeps a launch from turning
 * into a silent multi-minute download inside the handshake window; the caller
 * has already made sure the image is here.
 */
export function containerLaunchCommand(params: ContainerLaunchParams): ContainerCommand {
  const { config } = params;
  const mounts = config.mounts ?? [];
  return {
    command: containerEngineOf(config),
    args: [
      'run',
      '--rm',
      // stdin carries protocol frames; a tty would translate them, so `-i`
      // without `-t` is the only shape this transport can use.
      '-i',
      '--init',
      '--name',
      params.name,
      '--pull=never',
      ...(config.network === false ? ['--network', 'none'] : []),
      ...(config.cpus === undefined ? [] : ['--cpus', String(config.cpus)]),
      ...(config.memoryMib === undefined ? [] : ['--memory', `${config.memoryMib}m`]),
      ...mounts.flatMap((mount) => ['-v', mountSpecification(mount)]),
      '-v',
      `${params.runtimeBinaryPath}:${CONTAINER_RUNTIME_MOUNT_PATH}:ro`,
      '--entrypoint',
      CONTAINER_RUNTIME_MOUNT_PATH,
      config.image,
    ],
  };
}

function mountSpecification(mount: ContainerMount): string {
  return `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ':ro' : ''}`;
}
