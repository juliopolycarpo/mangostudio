#!/usr/bin/env bun
// Stands in for a build that is recording an AOT order: it runs `recordAotOrder` against a hub
// binary with a workload that never finishes, and leaves `<order file>.workload` once the hub is
// healthy, so a test can cancel it mid-recording and look for what it left behind.
// Usage: bun record-order-runner.ts <hub binary> <order file>
import { writeFileSync } from 'node:fs';

import { recordAotOrder } from '../../lib/aot-order';

const [hubBinary, orderFile] = process.argv.slice(2);
if (!hubBinary || !orderFile) {
  console.error('usage: record-order-runner.ts <hub binary> <order file>');
  process.exit(2);
}

await recordAotOrder(hubBinary, orderFile, {
  workload: () => {
    writeFileSync(`${orderFile}.workload`, 'started');
    return new Promise<never>(() => undefined);
  },
});
