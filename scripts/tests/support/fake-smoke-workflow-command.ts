// Named command fakes for executing the workflow's real shell steps. Docker
// containers are represented by files so the real smoke helper's EXIT trap
// can be checked, including its name reuse between Bookworm and Alpine.
// Usage: materialize this executable as bun/docker/podman/curl/ss in a fake PATH.
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const eventsPath = process.env.FAKE_SMOKE_WORKFLOW_EVENTS;
const stateDir = process.env.FAKE_SMOKE_WORKFLOW_STATE;
if (!eventsPath || !stateDir) {
  throw new Error(
    `Invalid fake workflow paths: ${JSON.stringify({ eventsPath, stateDir })}; expected writable events and state paths`
  );
}

const command = basename(process.argv[1] ?? '');
const args = process.argv.slice(2);
appendFileSync(
  eventsPath,
  `${JSON.stringify({
    command,
    args,
    engine: process.env.MANGO_CONTAINER_E2E_ENGINE,
    runtime: process.env.MANGO_CONTAINER_E2E_RUNTIME,
    platform: process.env.PLATFORM,
    skipBuild: process.env.SKIP_BUILD,
    buildCaller: process.env.FAKE_SMOKE_WORKFLOW_BUILD_CALLER,
  })}\n`
);

if (command === 'bun') {
  const firstContainer =
    args.some((arg) => arg.includes('connect-container-runtime.integration.test.ts')) &&
    process.env.MANGO_CONTAINER_E2E_ENGINE === 'docker' &&
    process.env.MANGO_CONTAINER_E2E_RUNTIME?.includes('/linux-x64/');
  const binaryHarness = args.some(
    (arg) => arg.includes('scripts/test-build.ts') || arg.includes('.mango/smoke/test-build.mjs')
  );
  const firstBinary = binaryHarness && !process.env.PLATFORM?.endsWith('-musl');
  const fail = process.env.FAKE_SMOKE_WORKFLOW_FAILURE;
  if ((fail === 'container' && firstContainer) || (fail === 'binary' && firstBinary)) {
    console.error('Deliberately failed first smoke assertion');
    process.exit(9);
  }
  if (binaryHarness && process.env.SKIP_BUILD === '0') {
    const build = Bun.spawnSync(
      [process.argv[1] ?? '', 'run', 'build:binary', '--platform', process.env.PLATFORM ?? ''],
      {
        env: {
          ...process.env,
          FAKE_SMOKE_WORKFLOW_REJECT_BUILD:
            fail === 'rejected-native-build' && firstBinary ? '1' : '0',
          FAKE_SMOKE_WORKFLOW_BUILD_CALLER: firstBinary ? 'native-harness' : 'alpine-harness',
        },
        stdout: 'inherit',
        stderr: 'inherit',
      }
    );
    process.exit(build.exitCode);
  }
  // A rejected runtime can leave both executables before verification fails.
  // Only a finished build writes the shared completion marker.
  const built = args.includes('build:binary') ? args[args.indexOf('--platform') + 1] : undefined;
  if (built) {
    rmSync(join('.mango', 'out', 'README.md'), { force: true });
    const target = join('.mango', 'out', built);
    mkdirSync(target, { recursive: true });
    for (const name of ['mangostudio', 'mangostudio-runtime']) {
      writeFileSync(join(target, name), '#!/usr/bin/env true\n', { mode: 0o755 });
    }
    if (process.env.FAKE_SMOKE_WORKFLOW_REJECT_BUILD === '1') {
      console.error('Deliberately rejected native build after staging both executables');
      process.exit(9);
    }
    writeFileSync(join('.mango', 'out', 'README.md'), 'Successfully built and verified.\n');
  }
  process.exit(0);
}

if (command === 'docker' || command === 'podman') {
  if (args[0] === 'run') {
    const name = args[args.indexOf('--name') + 1];
    if (!name) throw new Error(`Invalid fake engine run: ${JSON.stringify(args)}; expected --name`);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, name), 'running');
    const image = args.findIndex((arg) => arg.startsWith('oven/bun:'));
    if (image !== -1) {
      process.exit(runBunContainer(args, image, name, stateDir));
    }
    console.log('fake-container-id');
  }
  if (args[0] === 'rm') rmSync(join(stateDir, args.at(-1) ?? ''), { force: true });
  if (args[0] === 'ps') {
    const filter = args[args.indexOf('--filter') + 1]?.replace('name=', '') ?? '';
    const containers = readdirSync(stateDir).filter((name) => name.includes(filter));
    if (containers.length) console.log(containers.join('\n'));
  }
  if (args[0] === 'build' && args.includes('-')) await Bun.stdin.text();
  process.exit(0);
}

if (command === 'curl') {
  console.log(args.at(-1)?.endsWith('/api/health') ? '{"status":"ok"}' : '<html>fake UI</html>');
  process.exit(0);
}
if (command === 'ss') {
  const fail = process.env.FAKE_SMOKE_WORKFLOW_FAILURE;
  // A container that is still up holds its published port, like docker-proxy.
  const published = readdirSync(stateDir).some((name) => name.endsWith('-13002'));
  if ((fail === 'ports' || published) && args.some((arg) => arg.includes('13002'))) {
    console.log('LISTEN 0 128 127.0.0.1:13002 0.0.0.0:*');
  }
  // docker-proxy can hold the port for a moment after `docker rm -f` returns:
  // the first two probes of 13002 still see it, every later one finds it free.
  if (fail === 'slow-port' && args.some((arg) => arg.includes('13002'))) {
    const probes = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"command":"ss"') && line.includes('13002'));
    if (probes.length <= 2) console.log('LISTEN 0 128 127.0.0.1:13002 0.0.0.0:*');
  }
  // A native hub that outlived its smoke: only a filter naming 13001 sees it.
  if (fail === 'native-port' && args.some((arg) => arg.includes('13001'))) {
    console.log('LISTEN 0 128 127.0.0.1:13001 0.0.0.0:*');
  }
  process.exit(0);
}
if (command === 'sleep') process.exit(0);
if (command === 'apk' || command === 'git' || command === 'chown') process.exit(0);
throw new Error(
  `Invalid fake command: ${JSON.stringify(command)}; expected bun, docker, podman, curl, ss, sleep, apk, git or chown`
);

// Run the container's real command with named I/O fakes and its bind-mounted cwd.
function runBunContainer(
  runArgs: string[],
  image: number,
  name: string,
  containerStateDir: string
): number {
  const volume = runArgs[runArgs.indexOf('-v') + 1] ?? '';
  const mount = volume.indexOf(':/workspace');
  if (mount === -1) {
    throw new Error(`Invalid fake Bun container mount: ${volume}; expected <path>:/workspace[:ro]`);
  }
  const env = { ...process.env };
  for (let index = 0; index < image; index += 1) {
    if (runArgs[index] !== '-e') continue;
    const entry = runArgs[++index] ?? '';
    const separator = entry.indexOf('=');
    if (separator !== -1) env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  const invocation = runArgs.slice(image + 1);
  if (invocation[0] === 'bun') invocation[0] = join(dirname(process.argv[1] ?? ''), 'bun');
  try {
    return Bun.spawnSync(invocation, {
      cwd: volume.slice(0, mount),
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    }).exitCode;
  } finally {
    if (runArgs.includes('--rm')) rmSync(join(containerStateDir, name), { force: true });
  }
}
