/**
 * Path-containment algorithm tests live in `@mangostudio/runtime`. This file
 * keeps the hub re-export import path green for callers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInsideWorkdir,
  isInside,
  isPathPrefix,
  resolvePathForContainment,
  WorkdirContainmentError,
} from '../../../../src/modules/workspaces/application/path-containment';
import { resolveWorkspacePath } from '../../../../src/modules/workspaces/application/workspace-path';

let rootDir: string;
let outsideDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'contain-root-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'contain-out-'));
  mkdirSync(join(rootDir, 'nested'));
  writeFileSync(join(rootDir, 'nested', 'file.txt'), 'hello');
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('hub path-containment re-exports', () => {
  it('exposes the shared prefix and containment helpers', () => {
    expect(isPathPrefix(rootDir, join(rootDir, 'nested'))).toBe(true);
    expect(isInside(rootDir, join(rootDir, 'nested', 'file.txt'))).toBe(true);
    expect(resolvePathForContainment(join(rootDir, 'nested', 'planned.txt'))).toBe(
      join(rootDir, 'nested', 'planned.txt')
    );
    expect(resolveWorkspacePath(rootDir)).toBe(rootDir);
    expect(() => assertInsideWorkdir(rootDir, outsideDir)).toThrow(WorkdirContainmentError);
  });
});
