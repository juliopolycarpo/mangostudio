import { rename } from 'node:fs/promises';
import { join } from 'node:path';

const [binary, home] = process.argv.slice(2);
if (!binary || !home) throw new Error('expected runtime binary and private home');

async function publish(name: string, value: string): Promise<void> {
  const path = join(home, name);
  await Bun.write(`${path}.tmp`, value);
  await rename(`${path}.tmp`, path);
}

async function waitForGate(name: string): Promise<void> {
  while (!(await Bun.file(join(home, name)).exists())) await Bun.sleep(10);
}

await publish('version-wrapper-pid', String(process.pid));
await waitForGate('version-start');
const child = Bun.spawn([binary, '--version'], {
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
});
let stopped = false;
const monitorCancellation = async (): Promise<void> => {
  while (!stopped) {
    if (await Bun.file(join(home, 'version-cancel')).exists()) {
      child.kill('SIGKILL');
      return;
    }
    await Bun.sleep(10);
  }
};
const monitoring = monitorCancellation();
const code = await child.exited;
stopped = true;
await monitoring;
await publish('version-done', JSON.stringify({ pid: child.pid, code }));
await waitForGate('version-finish');
process.exit(code);
