#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  createFrontendArtifact,
  FRONTEND_ARTIFACT_FILE,
  frontendBuildEnvironment,
  verifyFrontendArtifact,
} from '../lib/frontend-artifact';

if (import.meta.main) {
  try {
    const [command, ...extra] = process.argv.slice(2);
    const producerRevision =
      extra[0] === '--bun-revision' && extra.length === 2 ? extra[1] : undefined;
    if (
      (command === 'verify'
        ? !producerRevision || !/^[a-f0-9]{40}$/.test(producerRevision)
        : extra.length > 0) ||
      !['clean', 'record', 'verify'].includes(command ?? '')
    ) {
      throw new Error(
        'frontend-artifact: expected clean | record | verify --bun-revision <40-character producer SHA>'
      );
    }
    if (command === 'clean') {
      for (const path of [
        'apps/frontend/dist',
        'apps/frontend/dist-metafile.json',
        FRONTEND_ARTIFACT_FILE,
      ]) {
        rmSync(join(ROOT_DIR, path), { recursive: true, force: true });
      }
    } else {
      const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT_DIR,
        encoding: 'utf8',
      }).trim();
      const dirty = execFileSync('git', ['status', '--porcelain'], {
        cwd: ROOT_DIR,
        encoding: 'utf8',
      }).trim();
      if (dirty)
        throw new Error(
          'frontend source: expected clean checkout; received modified or untracked inputs'
        );
      const identity = {
        sourceSha,
        bunRevision: command === 'verify' ? (producerRevision ?? '') : Bun.revision,
        lockfileSha256: createHash('sha256')
          .update(readFileSync(join(ROOT_DIR, 'bun.lock')))
          .digest('hex'),
        environment: frontendBuildEnvironment(process.env),
      };
      const manifest = join(ROOT_DIR, FRONTEND_ARTIFACT_FILE);
      if (command === 'record') {
        mkdirSync(join(ROOT_DIR, '.mango'), { recursive: true });
        writeFileSync(
          manifest,
          `${JSON.stringify(createFrontendArtifact(ROOT_DIR, identity), null, 2)}\n`
        );
      } else {
        verifyFrontendArtifact(ROOT_DIR, JSON.parse(readFileSync(manifest, 'utf8')), identity);
      }
      console.log(`Frontend ${command}: source ${sourceSha}, Bun ${Bun.revision}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
