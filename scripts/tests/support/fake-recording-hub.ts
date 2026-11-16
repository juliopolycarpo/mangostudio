#!/usr/bin/env bun
// A stand-in for a hub built with `--aot-record-order`. It answers `/api/health` and, on SIGTERM,
// writes the file `BUN_AOT_ORDER_OUT` names, the way a recording hub does. Beside that file it
// leaves `<file>.pid` and `<file>.env.json` (the environment it was started with) for the test to
// read. `FAKE_RECORDING_HUB` picks the behaviour:
//   records      write a well-formed order file, exit 0 (default)
//   silent-exit  exit 0 without writing a file
//   malformed    write a file Bun would ignore with a warning
//   crash        exit 3 before listening
//   no-health    stay alive without ever listening, and ignore SIGTERM
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_RECORDING_HUB ?? 'records';
const port = Number(process.argv[3]);
const out = process.env.BUN_AOT_ORDER_OUT;

if (out) {
  writeFileSync(`${out}.pid`, String(process.pid));
  writeFileSync(`${out}.env.json`, JSON.stringify(process.env));
}

if (mode === 'crash') {
  console.error('fake recording hub: crashing before it listens');
  process.exit(3);
}

if (mode === 'no-health') {
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1000);
} else {
  Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('ok') });
  process.on('SIGTERM', () => {
    if (mode === 'records' && out) {
      writeFileSync(out, 'aot-order v1\nP 100\nF = 7 b0 - 0:0 \nF = 3 b0 - 0:0 \n');
    } else if (mode === 'malformed' && out) {
      writeFileSync(out, 'not an order file\n');
    }
    process.exit(0);
  });
}
