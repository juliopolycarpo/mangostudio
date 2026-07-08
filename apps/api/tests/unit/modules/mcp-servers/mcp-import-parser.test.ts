import { describe, expect, it } from 'bun:test';
import { parseMcpImportSource } from '../../../../src/modules/mcp-servers/application/mcp-import-parser';
import { McpServerError } from '../../../../src/modules/mcp-servers/domain/mcp-server';

function parseOne(entry: unknown, key = 'server') {
  const entries = parseMcpImportSource(JSON.stringify({ mcpServers: { [key]: entry } }));
  expect(entries).toHaveLength(1);
  const first = entries[0];
  if (!first) throw new Error('unreachable');
  return first;
}

describe('parseMcpImportSource', () => {
  it('rejects sources that are not JSON objects', () => {
    expect(() => parseMcpImportSource('not json')).toThrow(McpServerError);
    expect(() => parseMcpImportSource('[1, 2]')).toThrow(McpServerError);
    expect(() => parseMcpImportSource('{"mcpServers": []}')).toThrow(McpServerError);
  });

  it('parses a Claude Code shaped stdio entry with args and env', () => {
    const { preview, body } = parseOne({
      command: 'bunx',
      args: ['@modelcontextprotocol/server-github', '--verbose'],
      env: { GITHUB_TOKEN: 'literal-token' },
    });

    expect(preview).toMatchObject({
      key: 'server',
      slug: 'server',
      transport: 'stdio',
      command: 'bunx',
      action: 'create',
    });
    expect(body).toEqual({
      name: 'server',
      slug: 'server',
      transport: 'stdio',
      command: 'bunx',
      args: ['@modelcontextprotocol/server-github', '--verbose'],
      env: { GITHUB_TOKEN: 'literal-token' },
    });
  });

  it('parses a Cursor shaped url-only entry as http', () => {
    const { preview, body } = parseOne({ url: 'https://mcp.example.com/sse-less' });

    expect(preview).toMatchObject({ transport: 'http', action: 'create' });
    expect(body).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/sse-less' });
  });

  it('parses a VS Code shaped source with a top-level servers key and explicit types', () => {
    const entries = parseMcpImportSource(
      JSON.stringify({
        servers: {
          local: { type: 'stdio', command: 'bun', args: ['run', 'server.ts'] },
          remote: { type: 'http', url: 'https://mcp.example.com/' },
        },
      })
    );

    expect(entries.map((entry) => entry.preview)).toMatchObject([
      { slug: 'local', transport: 'stdio', action: 'create' },
      { slug: 'remote', transport: 'http', action: 'create' },
    ]);
  });

  it('accepts a bare server map without a wrapper key', () => {
    const entries = parseMcpImportSource(JSON.stringify({ tools: { command: 'bun' } }));
    expect(entries.map((entry) => entry.preview)).toMatchObject([
      { slug: 'tools', transport: 'stdio', action: 'create' },
    ]);
  });

  it('keeps header values out of the preview, exposing names only', () => {
    const { preview, body } = parseOne({
      url: 'https://mcp.example.com/',
      headers: { Authorization: 'Bearer secret-token' },
    });

    expect(preview.headerNames).toEqual(['Authorization']);
    expect(JSON.stringify(preview)).not.toContain('secret-token');
    expect(body?.transport === 'http' && body.headers).toEqual({
      Authorization: 'Bearer secret-token',
    });
  });

  it('normalizes map keys into slugs and keeps the original key as the name', () => {
    const { preview } = parseOne({ command: 'bun' }, 'My GitHub_Tools!');
    expect(preview.slug).toBe('my-github-tools');
    expect(preview.name).toBe('My GitHub_Tools!');
    expect(preview.action).toBe('create');
  });

  it('flags sse and websocket transports as unsupported, never guessing a fallback', () => {
    const sse = parseOne({ type: 'sse', url: 'https://mcp.example.com/sse' });
    const ws = parseOne({ type: 'websocket', url: 'wss://mcp.example.com/' });

    expect(sse.preview).toMatchObject({
      action: 'unsupported',
      reason: 'unsupported-transport',
      detail: 'sse',
    });
    expect(sse.body).toBeUndefined();
    expect(ws.preview).toMatchObject({ action: 'unsupported', reason: 'unsupported-transport' });
  });

  it('flags placeholder expansions in any string field', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal editor placeholder under test
    const env = parseOne({ command: 'bun', env: { TOKEN: '${GITHUB_TOKEN}' } });
    const header = parseOne({
      url: 'https://mcp.example.com/',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal editor placeholder under test
      headers: { Authorization: 'Bearer ${input:token}' },
    });

    expect(env.preview).toMatchObject({
      action: 'unsupported',
      reason: 'placeholder-value',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal editor placeholder under test
      detail: '${GITHUB_TOKEN}',
    });
    expect(header.preview).toMatchObject({ action: 'unsupported', reason: 'placeholder-value' });
  });

  it('flags malformed entries instead of coercing them', () => {
    expect(parseOne('just a string').preview).toMatchObject({
      action: 'unsupported',
      reason: 'invalid-entry',
    });
    expect(parseOne({}).preview).toMatchObject({
      action: 'unsupported',
      reason: 'unsupported-transport',
    });
    expect(parseOne({ command: 'bun', args: [1, 2] }).preview).toMatchObject({
      action: 'unsupported',
      reason: 'invalid-entry',
    });
    expect(parseOne({ command: 'bun', env: { PORT: 3000 } }).preview).toMatchObject({
      action: 'unsupported',
      reason: 'invalid-entry',
    });
    expect(parseOne({ url: 'ftp://example.com/' }).preview).toMatchObject({
      action: 'unsupported',
      reason: 'invalid-entry',
    });
  });

  it('flags keys that cannot become a slug', () => {
    expect(parseOne({ command: 'bun' }, '!!!').preview).toMatchObject({
      action: 'unsupported',
      reason: 'invalid-slug',
    });
  });

  it('skips the second entry when two keys normalize to the same slug', () => {
    const entries = parseMcpImportSource(
      JSON.stringify({
        mcpServers: {
          'my-server': { command: 'bun' },
          'My Server': { command: 'deno' },
        },
      })
    );

    expect(entries.map((entry) => entry.preview)).toMatchObject([
      { slug: 'my-server', action: 'create' },
      { slug: 'my-server', action: 'skip-duplicate', reason: 'duplicate-in-source' },
    ]);
  });
});
