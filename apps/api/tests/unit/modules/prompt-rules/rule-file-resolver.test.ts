import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultRuleFileDescriptors,
  previewRuleFile,
  RuleFileError,
} from '../../../../src/modules/prompt-rules/application/rule-file-resolver';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mango-rule-file-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createFile(name: string, content: string): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function createDirectory(name: string): string {
  const dirPath = join(tmpDir, name);
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function createLargeFile(name: string, sizeBytes: number): string {
  const filePath = join(tmpDir, name);
  const content = 'x'.repeat(sizeBytes);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('getDefaultRuleFileDescriptors', () => {
  it('returns AGENTS.md and CLAUDE.md descriptors', () => {
    const descriptors = getDefaultRuleFileDescriptors();

    expect(descriptors.length).toBe(2);

    const agents = descriptors.find((d) => d.kind === 'agents');
    const claude = descriptors.find((d) => d.kind === 'claude');

    expect(agents).toBeDefined();
    expect(agents?.label).toBe('Mango AGENTS.md');
    expect(claude).toBeDefined();
    expect(claude?.label).toBe('Claude CLAUDE.md');
  });

  it('returns exists: false for missing default files', () => {
    const descriptors = getDefaultRuleFileDescriptors();

    for (const d of descriptors) {
      if (!d.exists) {
        expect(d.readable).toBe(false);
        expect(d.sizeBytes).toBeUndefined();
      }
    }
  });
});

describe('previewRuleFile', () => {
  it('reads content from a valid .md file', () => {
    const filePath = createFile('test.md', '# Hello World\n\nSome content.');
    const result = previewRuleFile(filePath);

    expect(result.exists).toBe(true);
    expect(result.readable).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('# Hello World\n\nSome content.');
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('expands ~ to home directory', () => {
    const homeRelative = '~/some-file.md';
    void homeRelative;
    const filePath = createFile('manual.md', 'test content');

    const result = previewRuleFile(filePath);

    expect(result.exists).toBe(true);
    expect(result.content).toBe('test content');
  });

  it('rejects non-.md extensions', () => {
    const filePath = createFile('test.txt', 'not markdown');

    expect(() => previewRuleFile(filePath)).toThrow(RuleFileError);
    try {
      previewRuleFile(filePath);
    } catch (err) {
      expect(err).toBeInstanceOf(RuleFileError);
      expect((err as RuleFileError).code).toBe('VALIDATION');
    }
  });

  it('rejects extensionless files', () => {
    const filePath = createFile('nofile', 'no extension');

    expect(() => previewRuleFile(filePath)).toThrow(RuleFileError);
  });

  it('rejects directories', () => {
    const dirPath = createDirectory('some-dir.md');

    expect(() => previewRuleFile(dirPath)).toThrow(RuleFileError);
    try {
      previewRuleFile(dirPath);
    } catch (err) {
      expect(err).toBeInstanceOf(RuleFileError);
      expect((err as RuleFileError).code).toBe('VALIDATION');
    }
  });

  it('rejects relative paths', () => {
    expect(() => previewRuleFile('./relative/path.md')).toThrow(RuleFileError);
    try {
      previewRuleFile('./relative/path.md');
    } catch (err) {
      expect(err).toBeInstanceOf(RuleFileError);
      expect((err as RuleFileError).code).toBe('VALIDATION');
    }
  });

  it('returns error for missing files', () => {
    const missingPath = join(tmpDir, 'nonexistent.md');

    expect(() => previewRuleFile(missingPath)).toThrow(RuleFileError);
    try {
      previewRuleFile(missingPath);
    } catch (err) {
      expect(err).toBeInstanceOf(RuleFileError);
      expect((err as RuleFileError).code).toBe('NOT_FOUND');
    }
  });

  it('truncates oversized files', () => {
    const MAX_BYTES = 256 * 1024;
    const filePath = createLargeFile('large.md', MAX_BYTES + 1000);

    const result = previewRuleFile(filePath);

    expect(result.truncated).toBe(true);
    const content = result.content as string;
    expect(content.length).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('does not truncate files at exactly the cap', () => {
    const MAX_BYTES = 256 * 1024;
    const filePath = createLargeFile('exact.md', MAX_BYTES);

    const result = previewRuleFile(filePath);

    expect(result.truncated).toBe(false);
    const exactContent = result.content as string;
    expect(exactContent.length).toBe(MAX_BYTES);
  });

  it('throws for unreadable empty content read failure', () => {
    const filePath = createFile('empty.md', '');

    const result = previewRuleFile(filePath);

    expect(result.content).toBe('');
    expect(result.truncated).toBe(false);
  });
});
