import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectFrontendBundle } from './bundle';

const tempDirs: string[] = [];
let priorFrontendDist: string | undefined;

afterEach(async () => {
  if (priorFrontendDist === undefined) {
    delete process.env.QA_FRONTEND_DIST;
  } else {
    process.env.QA_FRONTEND_DIST = priorFrontendDist;
  }
  priorFrontendDist = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A dist directory shaped like a real build: a shell plus at least one script. */
const withDistFixture = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-qa-bundle-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'app.js'), 'console.log("hi");\n', 'utf8');
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>x</title>\n', 'utf8');
  return dir;
};

describe('collectFrontendBundle', () => {
  test('measures a provided dist directory without spawning a build', async () => {
    const distDir = await withDistFixture();
    priorFrontendDist = process.env.QA_FRONTEND_DIST;
    process.env.QA_FRONTEND_DIST = distDir;

    let buildCalls = 0;
    const stats = await collectFrontendBundle({
      buildFrontend: () => {
        buildCalls += 1;
        return Promise.resolve(distDir);
      },
    });

    expect(buildCalls).toBe(0);
    expect(stats.files).toBe(2);
    expect(stats.rawBytes).toBeGreaterThan(0);
    expect(stats.gzipBytes).toBeGreaterThan(0);
    expect(stats.jsGzipBytes + stats.htmlGzipBytes).toBe(stats.gzipBytes);
  });

  test('throws when QA_FRONTEND_DIST is set but the path is missing', async () => {
    priorFrontendDist = process.env.QA_FRONTEND_DIST;
    process.env.QA_FRONTEND_DIST = join(tmpdir(), 'mango-missing-frontend-dist');

    await expect(
      collectFrontendBundle({
        buildFrontend: () => Promise.reject(new Error('build should not run')),
      })
    ).rejects.toThrow(/missing/);
  });

  test('throws when QA_FRONTEND_DIST is set but the directory is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-qa-bundle-empty-'));
    tempDirs.push(dir);
    priorFrontendDist = process.env.QA_FRONTEND_DIST;
    process.env.QA_FRONTEND_DIST = dir;

    await expect(
      collectFrontendBundle({
        buildFrontend: () => Promise.reject(new Error('build should not run')),
      })
    ).rejects.toThrow(/empty/);
  });

  test('falls back to buildFrontend when QA_FRONTEND_DIST is unset', async () => {
    priorFrontendDist = process.env.QA_FRONTEND_DIST;
    delete process.env.QA_FRONTEND_DIST;

    const distDir = await withDistFixture();
    let buildCalls = 0;
    const stats = await collectFrontendBundle({
      buildFrontend: () => {
        buildCalls += 1;
        return Promise.resolve(distDir);
      },
    });

    expect(buildCalls).toBe(1);
    expect(stats.files).toBe(2);
  });

  // A dist that exists and holds files the walker cannot turn into a bundle is
  // the failure that has to throw rather than return zeroes: `files: 0` renders
  // as a bundle that shrank to nothing, which the verdict reads as good news.
  // Both spellings below pass assertDistUsable, so this is the only guard left.
  test.each([
    ['holds no bundle files at all', ['notes.txt']],
    ['holds no shell to go with its scripts', ['app.js']],
    ['holds no script to go with its shell', ['index.html']],
  ])('throws when the dist %s', async (_label, names) => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-qa-bundle-partial-'));
    tempDirs.push(dir);
    for (const name of names) await writeFile(join(dir, name), 'x\n', 'utf8');
    priorFrontendDist = process.env.QA_FRONTEND_DIST;
    process.env.QA_FRONTEND_DIST = dir;

    await expect(
      collectFrontendBundle({
        buildFrontend: () => Promise.reject(new Error('build should not run')),
      })
    ).rejects.toThrow(/present but not measurable/);
  });
});
