#!/usr/bin/env bun

import { ROOT_DIR } from '../lib/config';
import { assembleNativeHubs } from '../lib/native-hub-assembly';
import { resolveReleaseVersion } from '../lib/release-version';

const sourceSha = process.env.SOURCE_SHA?.trim();
if (!sourceSha || !/^[a-f\d]{40}$/.test(sourceSha)) {
  throw new Error(`expected SOURCE_SHA: full Git SHA | received: ${String(sourceSha)}`);
}
const version = resolveReleaseVersion();
const records = assembleNativeHubs(ROOT_DIR, { sourceSha, version });
const revisions = [...new Set(records.map((record) => record.compilerRevision))];
if (revisions.length > 1) {
  console.warn(
    `Bun canary advanced between target builds; per-target revisions are retained: ${revisions.join(', ')}`
  );
}
console.log(`Verified ${records.length} native hub/runtime pairs for ${sourceSha} v${version}.`);
