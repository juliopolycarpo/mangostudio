#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { stageApprovedCanary } from '../lib/canary-approval-staging';
import { parseCanaryPromotionReceipt } from '../lib/canary-publication-evidence';
import { requiredEnv } from '../lib/runner';
import { stageCanaryAssets } from '../release/stage-canary-assets';

/** Consume an authenticated prepare result plus downloaded original asset scope; never rebuild. */
async function main(): Promise<void> {
  const approvalDir = resolve(requiredEnv('APPROVAL_DIR'));
  const assetDir = resolve(process.env.ASSET_DIR ?? 'release-assets');
  const stageDir = resolve(process.env.STAGE_DIR ?? 'github-canary-assets');
  for (const path of [approvalDir, assetDir, stageDir])
    if (/[\r\n\0]/.test(path))
      throw new Error('Invalid staging path: expected plain filesystem path');
  const receipt = parseCanaryPromotionReceipt(
    readFileSync(join(approvalDir, 'promotion.json'), 'utf8'),
    requiredEnv('REPO'),
    requiredEnv('SOURCE_SHA')
  );
  const names = await stageApprovedCanary(
    {
      // This is the downloaded asset-scope manifest, never a copied prepare manifest.
      manifestRaw: readFileSync(requiredEnv('MANIFEST_PATH'), 'utf8'),
      receipt,
      checksumsBundle: readFileSync(join(approvalDir, 'promotion-checksums.tar.gz')),
      approvalPayload: readFileSync(join(approvalDir, 'approval.tar.gz')),
      approvalPayloadSha256: requiredEnv('EXPECTED_APPROVAL_SHA256'),
      expectedReleaseSha256: requiredEnv('EXPECTED_RELEASE_SHA256'),
    },
    {
      async stage(version, sourceSha, builtAt) {
        stageCanaryAssets({ version, sourceSha, builtAt, inDir: assetDir, outDir: stageDir });
        await Promise.resolve();
      },
      async write(name, bytes) {
        mkdirSync(stageDir, { recursive: true });
        writeFileSync(join(stageDir, name), bytes);
        await Promise.resolve();
      },
      async read(name) {
        return await Bun.file(join(stageDir, name)).bytes();
      },
    }
  );
  console.log(JSON.stringify({ stageDir, assets: names }));
}
if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  }
}
