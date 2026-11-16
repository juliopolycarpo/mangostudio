#!/usr/bin/env bun
// A stand-in for a hub built with `--aot-record-order`. It answers `/api/health`, records its
// state file under `MANGO_HOME` the way a hub does, and, on SIGTERM, writes the file
// `BUN_AOT_ORDER_OUT` names, the way a recording hub does. Beside that file it leaves `<file>.pid`
// and `<file>.env.json` (the environment it was started with) for the test to read.
// The recorder starts a hub with an allowlisted environment, so the behaviour comes from the file
// `<BUN_AOT_ORDER_OUT>.mode` (default `records`):
//   records      write a well-formed order file, exit 0 (default)
//   silent-exit  exit 0 without writing a file
//   malformed    write a file Bun would ignore with a warning
//   crash        exit 3 before listening
//   no-health    stay alive without ever listening, and ignore SIGTERM
//   no-state     answer health but never write the state file: a stranger on the port looks like this
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[3]);
const out = process.env.BUN_AOT_ORDER_OUT;
const modeFile = `${out}.mode`;
const mode = out && existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'records';

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
  // `<file>.health-2` appears once the second request arrives: by then the caller has finished
  // handling the answer to the first, which is what a test about that handling waits for.
  let requests = 0;
  Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: () => {
      requests += 1;
      if (requests === 2 && out) writeFileSync(`${out}.health-2`, '2');
      return new Response('ok');
    },
  });
  if (mode !== 'no-state' && process.env.MANGO_HOME) {
    const runDir = join(process.env.MANGO_HOME, '.mango', 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'server.json'),
      JSON.stringify({ pid: process.pid, port, startedAt: Date.now() })
    );
  }
  process.on('SIGTERM', () => {
    if (mode === 'records' && out) {
      writeFileSync(out, 'aot-order v1\nP 100\nF = 7 b0 - 0:0 \nF = 3 b0 - 0:0 \n');
    } else if (mode === 'malformed' && out) {
      writeFileSync(out, 'not an order file\n');
    }
    process.exit(0);
  });
}
