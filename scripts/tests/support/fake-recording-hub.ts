#!/usr/bin/env bun
// A stand-in for a hub built with `--aot-record-order`. It answers `/api/health`, records its
// state file under `MANGO_HOME` the way a hub does, and, on SIGTERM, writes the file
// `BUN_AOT_ORDER_OUT` names, the way a recording hub does. Beside that file it leaves `<file>.pid`
// `<file>.env.json` (the environment it was started with) and `<file>.sibling.json` (whether a
// `mangostudio-runtime` sits next to this script, and if it is executable) for the test to read.
// The recorder starts a hub with an allowlisted environment, so the behaviour comes from the file
// `<BUN_AOT_ORDER_OUT>.mode` (default `records`):
//   records      write a well-formed order file, exit 0 (default)
//   private      the same file, readable by its owner only
//   silent-exit  exit 0 without writing a file
//   malformed    write a file Bun would ignore with a warning
//   crash        exit 3 before listening
//   no-health    stay alive without ever listening, and ignore SIGTERM
//   no-state     answer health but never write the state file: a stranger on the port looks like this
//   no-runtime-launch  as `records`, but never start the runtime sitting beside it
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const port = Number(process.argv[3]);
const out = process.env.BUN_AOT_ORDER_OUT;
const modeFile = `${out}.mode`;
const mode = out && existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'records';

if (out) {
  // What an installed hub would find beside itself: a runtime next to this script, and whether it
  // can be executed. Written first so the test can read it once the hub is up.
  const sibling = join(dirname(process.argv[1] as string), 'mangostudio-runtime');
  writeFileSync(
    `${out}.sibling.json`,
    JSON.stringify({
      present: existsSync(sibling),
      executable: existsSync(sibling) && (statSync(sibling).mode & 0o111) !== 0,
      content: existsSync(sibling) ? readFileSync(sibling, 'utf8') : null,
    })
  );
  // An installed hub launches the runtime beside it as `<runtime> --stdio`, a child of its own
  // process group; the recorder looks for that child. `no-runtime-launch` is a hub that never does.
  if (existsSync(sibling) && mode !== 'no-runtime-launch') {
    Bun.spawn([sibling, '--stdio'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  }
  // The pid file is the test's "hub is up" signal, so it appears last and whole: a test that
  // kills the hub the moment it sees the pid must find the environment file already there, and
  // must never read a pid file that exists but is still empty.
  writeFileSync(`${out}.env.json`, JSON.stringify(process.env));
  writeFileSync(`${out}.pid.partial`, String(process.pid));
  renameSync(`${out}.pid.partial`, `${out}.pid`);
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
    if ((mode === 'records' || mode === 'private' || mode === 'no-runtime-launch') && out) {
      writeFileSync(out, 'aot-order v1\nP 100\nF = 7 b0 - 0:0 \nF = 3 b0 - 0:0 \n', {
        mode: mode === 'private' ? 0o600 : 0o644,
      });
    } else if (mode === 'malformed' && out) {
      writeFileSync(out, 'not an order file\n');
    }
    process.exit(0);
  });
}
