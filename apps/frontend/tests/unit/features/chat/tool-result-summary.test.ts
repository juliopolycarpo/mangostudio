import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import {
  formatToolSummary,
  getToolGroupSummary,
  getToolResultSummary,
} from '@/features/chat/components/tool-result-summary';

const labels = en.tools.summary;

function summarize(name: string, result: string | null, args: Record<string, unknown> = {}) {
  const summary = getToolResultSummary(name, result, args);
  return summary === null ? null : formatToolSummary(summary, labels);
}

describe('getToolResultSummary', () => {
  it('counts what each search and listing tool returned', () => {
    expect(summarize('list_directory', '{"path":"/a","entries":[{},{},{}]}')).toBe('3 items');
    expect(summarize('glob', '{"matches":["a","b"]}')).toBe('2 files');
    expect(summarize('grep', '{"matches":[{},{},{}]}')).toBe('3 hits');
  });

  it('reports the window a read actually returned, not the whole file', () => {
    expect(summarize('read_file', '{"startLine":1,"endLine":84,"totalLines":2000}')).toBe(
      '84 lines'
    );
  });

  it('falls back to the file length when a read reported no window', () => {
    expect(summarize('read_file', '{"totalLines":12}')).toBe('12 lines');
  });

  it('uses the singular form at one', () => {
    expect(summarize('grep', '{"matches":[{}]}')).toBe('1 hit');
    expect(summarize('edit_file', '{"replacements":1}')).toBe('1 replacement');
  });

  it('counts the body a write was given, since the result reports only bytes', () => {
    expect(summarize('write_file', '{"bytesWritten":9}', { content: 'a\nb\nc' })).toBe('3 lines');
    // A trailing newline closes the last line rather than opening a new one.
    expect(summarize('create_file', '{"bytesWritten":4}', { content: 'a\nb\n' })).toBe('2 lines');
  });

  it('names a shell failure by its exit code instead of counting its output', () => {
    expect(summarize('bash', '{"exitCode":1,"stdout":"boom\\n"}')).toBe('exit 1');
    expect(summarize('bash', '{"exitCode":0,"stdout":"one\\ntwo\\n"}')).toBe('2 lines');
  });

  it('stays silent when the payload does not answer the question', () => {
    expect(getToolResultSummary('grep', null)).toBeNull();
    expect(getToolResultSummary('grep', 'not json')).toBeNull();
    expect(getToolResultSummary('grep', '{"pattern":"x"}')).toBeNull();
    expect(getToolResultSummary('some_mcp_tool', '{"anything":1}')).toBeNull();
  });
});

describe('getToolGroupSummary', () => {
  it('totals the units a search run returned', () => {
    const summary = getToolGroupSummary('grep', [
      { result: '{"matches":[{},{}]}', args: {} },
      { result: '{"matches":[{}]}', args: {} },
    ]);
    expect(summary && formatToolSummary(summary, labels)).toBe('3 hits');
  });

  // Summing the lines of four separate reads produces a number that describes
  // no file, so a file-targeted run counts its files instead.
  it('counts files for a run of file-targeted calls', () => {
    const summary = getToolGroupSummary('read_file', [
      { result: '{"startLine":1,"endLine":84}', args: {} },
      { result: '{"startLine":1,"endLine":9}', args: {} },
    ]);
    expect(summary && formatToolSummary(summary, labels)).toBe('2 files');
  });

  it('falls back to counting calls when a search run has an unreadable member', () => {
    const summary = getToolGroupSummary('grep', [
      { result: '{"matches":[{},{}]}', args: {} },
      { result: null, args: {} },
    ]);
    expect(summary && formatToolSummary(summary, labels)).toBe('2 calls');
  });

  it('has nothing to say about an empty run', () => {
    expect(getToolGroupSummary('grep', [])).toBeNull();
  });
});
