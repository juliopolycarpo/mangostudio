import { join } from 'node:path';
import {
  type NativeCommandReceipt,
  type NativeProcess,
  snapshotNativeProcesses,
} from '../../lib/native-bun-qualification-process';

/** A named fixture barrier which registers exact child identities before allowing cancellation. Example: const owned = await barrier.observe(binary, pending); await barrier.release(); */
export class FakeBenchmarkCancelBarrier {
  constructor(private readonly directory: string) {}

  async observe(binary: string, pending: Promise<NativeCommandReceipt>): Promise<NativeProcess[]> {
    const marker = join(this.directory, 'stall-reached');
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const deadline = Date.now() + 15_000;
    while (!settled && Date.now() < deadline && !(await Bun.file(marker).exists()))
      await Bun.sleep(5);
    if (!(await Bun.file(marker).exists())) {
      const result = await pending;
      const stdout = await Bun.file(join(this.directory, `logs/${result.label}.stdout.log`)).text();
      const stderr = await Bun.file(join(this.directory, `logs/${result.label}.stderr.log`)).text();
      throw new Error(
        `Cancellation fixture: expected started barrier ${marker} | received: exitCode=${result.exitCode}, signal=${result.signal}, timedOut=${result.timedOut}, canceled=${result.canceled ?? false}\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }
    const owned = (await snapshotNativeProcesses()).filter((row) => row.command.includes(binary));
    if (!owned.length) {
      await pending.catch(() => undefined);
      throw new Error(
        `Cancellation fixture: expected live child identity for ${binary} | received: no matching process`
      );
    }
    return owned;
  }

  async release(): Promise<void> {
    await Bun.write(join(this.directory, 'cancel-now'), 'cancel registered fixture');
  }
}
