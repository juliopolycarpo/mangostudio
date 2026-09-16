/**
 * `@mangostudio/protocol/spawn`: the child-process launcher and the hardened
 * ssh argv preset. This entry may import `node:`; the core entry may not.
 */

export {
  type ExitStatus,
  type LaunchedPeer,
  type SpawnChild,
  type SpawnedPeer,
  type SpawnOptions,
  type SpawnStartError,
  sanitizedEnv,
  spawnPort,
} from './transports/spawn';
export { classifySshExit, type SshArgvOptions, sshArgv } from './transports/ssh';
