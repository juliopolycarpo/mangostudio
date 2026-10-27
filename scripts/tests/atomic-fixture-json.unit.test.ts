import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { type FixtureJsonFiles, publishFixtureJson } from './support/atomic-fixture-json';

/** Keeps exact documents and exposes interruption before publication. */
class InterruptedFixtureFiles implements FixtureJsonFiles {
  readonly documents = new Map<string, string>();
  readonly operations: string[] = [];
  writeFailure: Error | null = null;
  renameFailure: Error | null = null;

  write = (path: string, text: string): void => {
    this.operations.push(`write:${path}`);
    this.documents.set(path, this.writeFailure ? text.slice(0, 3) : text);
    if (this.writeFailure) throw this.writeFailure;
  };

  rename = (source: string, destination: string): void => {
    this.operations.push(`rename:${source}:${destination}`);
    if (this.renameFailure) throw this.renameFailure;
    const text = this.read(source);
    this.documents.set(destination, text);
    this.documents.delete(source);
  };

  read(path: string): string {
    const text = this.documents.get(path);
    if (text === undefined) throw new Error(`fixture ${path}: expected an existing document`);
    return text;
  }
}

const previous = { beat: 1, at: 1000 };
const current = { beat: 2, at: 1050 };
const target = '/fixture/formatter.beat';

describe('atomic fixture JSON publication', () => {
  it('keeps the last complete document when a staging write is interrupted', () => {
    const files = new InterruptedFixtureFiles();
    files.documents.set(target, JSON.stringify(previous));
    files.writeFailure = new Error('controlled interruption during fixture write');

    expect(() => publishFixtureJson(target, current, files)).toThrow(files.writeFailure.message);
    expect(files.read(target), `${target}: expected the last complete JSON document`).toBe(
      JSON.stringify(previous)
    );
    expect(JSON.parse(files.read(target))).toEqual(previous);
    expect(files.operations.some((operation) => operation.startsWith('rename:'))).toBe(false);
  });

  it('replaces the old value with the complete current value', () => {
    const files = new InterruptedFixtureFiles();
    files.documents.set(target, JSON.stringify(previous));
    publishFixtureJson(target, current, files);
    expect(JSON.parse(files.read(target))).toEqual(current);
    expect([...files.documents.keys()]).toEqual([target]);
    expect(files.operations).toHaveLength(2);
  });

  it('retains the previous document and the original failure when rename is interrupted', () => {
    const files = new InterruptedFixtureFiles();
    files.documents.set(target, JSON.stringify(previous));
    files.renameFailure = new Error('controlled interruption before fixture rename');
    expect(() => publishFixtureJson(target, current, files)).toThrow(files.renameFailure.message);
    expect(JSON.parse(files.read(target))).toEqual(previous);
    const staged = [...files.documents.keys()].find((path) => path !== target);
    expect(staged).toBeDefined();
    expect(dirname(staged as string)).toBe(dirname(target));
    expect(JSON.parse(files.read(staged as string))).toEqual(current);
  });

  it('publishes a first document and replaces it through real sibling-file renames', () => {
    const directory = mkdtempSync(join(tmpdir(), "fixture-json-O'Brien-雪-"));
    const path = join(directory, 'formatter.beat');
    try {
      publishFixtureJson(path, previous);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(previous);
      publishFixtureJson(path, current);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(current);
      expect(readdirSync(directory)).toEqual(['formatter.beat']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
