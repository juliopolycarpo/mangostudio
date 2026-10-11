// Named command fakes for executing the workflow's real shell steps. Docker
// containers are represented by files so the real smoke helper's EXIT trap
// can be checked, including its name reuse between Bookworm and Alpine.
// Usage: materialize this executable as bun/docker/podman/curl/ss in a fake PATH.
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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
  })}\n`
);

if (command === 'bun') {
  const firstContainer =
    args.some((arg) => arg.includes('connect-container-runtime.integration.test.ts')) &&
    process.env.MANGO_CONTAINER_E2E_ENGINE === 'docker' &&
    process.env.MANGO_CONTAINER_E2E_RUNTIME?.includes('/linux-x64/');
  const firstBinary = args.some((arg) => arg.includes('scripts/test-build.ts'));
  const fail = process.env.FAKE_SMOKE_WORKFLOW_FAILURE;
  if ((fail === 'container' && firstContainer) || (fail === 'binary' && firstBinary)) {
    console.error('Deliberately failed first smoke assertion');
    process.exit(9);
  }
  // A finished build leaves the hub and its runtime side by side.
  const built = args.includes('build:binary')
    ? args[args.indexOf('--platform') + 1]
    : firstBinary && process.env.SKIP_BUILD === '0'
      ? process.env.PLATFORM
      : undefined;
  if (built) {
    const target = join('.mango', 'out', built);
    mkdirSync(target, { recursive: true });
    for (const name of ['mangostudio', 'mangostudio-runtime']) {
      writeFileSync(join(target, name), '#!/usr/bin/env true\n', { mode: 0o755 });
    }
  }
  process.exit(0);
}

if (command === 'docker' || command === 'podman') {
  if (args[0] === 'run') {
    const name = args[args.indexOf('--name') + 1];
    if (!name) throw new Error(`Invalid fake engine run: ${JSON.stringify(args)}; expected --name`);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, name), 'running');
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
  // A native hub that outlived its smoke: only a filter naming 13001 sees it.
  if (fail === 'native-port' && args.some((arg) => arg.includes('13001'))) {
    console.log('LISTEN 0 128 127.0.0.1:13001 0.0.0.0:*');
  }
  process.exit(0);
}
if (command === 'sleep') process.exit(0);
throw new Error(
  `Invalid fake command: ${JSON.stringify(command)}; expected bun, docker, podman, curl, ss or sleep`
);
