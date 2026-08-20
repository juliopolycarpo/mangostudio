#!/usr/bin/env bun

// Resolves the Bun runtime for every release target from an empty cache, the
// way a cold release build does — concurrently, against the real release host.
//
// Run by hand, not by CI. `.bun-version` pins a released Bun, so the fetcher it
// exercises is dormant and this exits immediately saying so; the two lanes that
// used to run it nightly and per-PR were verifying nothing. It is the check to
// run — and the lanes to restore — if `.bun-version` ever names a channel again.
//
// This is the only thing that exercises `scripts/lib/bun-cross-runtime.ts` end
// to end. A local server cannot stand in: the concurrent-download deadlock this
// guards against needs TLS, the github.com → objects.githubusercontent.com
// redirect, or real socket backpressure, and does not reproduce over loopback.
// So a live run really fetches ~222 MB and finishes in seconds; a stall is what
// failure looks like, which is why the lanes that ran it carried a tight
// timeout, and why a restored one must carry it too.
//
// Compiling nothing is the point. The `distribution` job proves the same thing
// by building sixteen binaries, and only runs when a distribution-relevant path
// changed — leaving a release-critical path guarded by the most expensive job
// that happens to contain it.

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bunCompiledRuntimes,
  bunCrossCompileChannel,
  ensureBunCrossRuntime,
} from '../lib/bun-cross-runtime';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';

const channel = await bunCrossCompileChannel();
if (!channel) {
  console.log(
    '`.bun-version` pins a released Bun, so `--compile` resolves its own downloads and there is no fetch path to verify.'
  );
  process.exit(0);
}

// A fresh directory per run, outside `.mango/`, so neither a warm repo cache nor
// a previous run of this script can answer for the network.
const cacheDir = await mkdtemp(join(tmpdir(), 'verify-cross-runtimes-'));
const cacheKey = 'cold';
const startedAt = Date.now();

try {
  console.log(
    `Resolving ${ALL_BINARY_TARGETS.length} runtimes for the "${channel}" channel from a cold cache…`
  );

  // Concurrently, and deliberately: one download at a time always worked, and
  // the failure being guarded only appears when several are in flight.
  const resolved = await Promise.all(
    ALL_BINARY_TARGETS.map(async (target) => ({
      arch: target.arch,
      path: await ensureBunCrossRuntime(target, { channel, cacheDir, cacheKey }),
    }))
  );

  const provenance = await bunCompiledRuntimes(channel, { cacheDir, cacheKey });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  for (const { arch, path } of resolved) {
    const { size } = await stat(path);
    if (size === 0) {
      throw new Error(`${arch}: resolved ${path}, which is empty`);
    }
    const runtime = provenance[arch];
    const identity =
      runtime?.source === 'host'
        ? `host Bun ${runtime.revision}`
        : `sha256 ${runtime?.sha256 ?? 'unrecorded'}${runtime?.tagAdvanced ? ' (tag advanced mid-fetch)' : ''}`;
    console.log(`  ${arch.padEnd(17)} ${identity}`);
  }

  const missing = ALL_BINARY_TARGETS.filter((target) => !provenance[target.arch]);
  if (missing.length > 0) {
    throw new Error(
      `No provenance recorded for: ${missing.map((target) => target.arch).join(', ')}`
    );
  }

  console.log(`Resolved ${resolved.length} runtimes in ${elapsed}s.`);
} catch (caught) {
  console.error(
    `Cross-runtime resolution failed: ${caught instanceof Error ? caught.message : String(caught)}`
  );
  process.exitCode = 1;
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
