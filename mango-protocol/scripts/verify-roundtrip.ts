/**
 * Proves the two SDKs read each other's bytes: every frame-corpus line is
 * sent to the Rust crate's `roundtrip` example, which decodes it and answers
 * with its own encoding or its refusal reason; the TypeScript SDK then decodes
 * the answers. Accepted lines must agree member for member, refused lines must
 * name the same reason. Runs inside `bun run check` when Cargo is present.
 *
 * @example
 * bun ./scripts/verify-roundtrip.ts
 */

import { decodeLine } from '../packages/protocol/src/codec/ndjson';
import frames from '../spec/fixtures/1/frames.json';
import { hasCargo, ROOT_DIR, warnNoCargo } from './lib';
import { type CorpusCase, judgeAnswers, parseAnswer, roundTripCases } from './roundtrip';

if (!hasCargo()) {
  warnNoCargo();
  process.exit(0);
}

const cases = roundTripCases(frames.cases as readonly CorpusCase[]);
const proc = Bun.spawn(['cargo', 'run', '--quiet', '--locked', '--example', 'roundtrip'], {
  cwd: `${ROOT_DIR}/crates/mango-protocol`,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});
proc.stdin.write(`${cases.map((entry) => entry.line).join('\n')}\n`);
await proc.stdin.end();
const [stdout, stderr, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
if (code !== 0) {
  console.error(`cargo run --example roundtrip failed (${code}):\n${stderr}`);
  process.exit(1);
}

const answers = stdout
  .split('\n')
  .filter((line) => line !== '')
  .map(parseAnswer);
const failures = judgeAnswers(cases, answers, (line) => decodeLine(line));
if (failures.length > 0) {
  console.error(`round trip failed (${failures.length}):`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`round trip: ${cases.length} corpus lines agree between TypeScript and Rust`);
