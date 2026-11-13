import { expect, test } from 'bun:test';

import { CanaryGitHub, type GhCommandResult, type GhCommandRunner } from '../lib/canary-github';

class FakeGhRunner implements GhCommandRunner {
  readonly calls: string[][] = [];
  readonly responses = new Map<string, GhCommandResult>();
  run(args: readonly string[]): GhCommandResult {
    this.calls.push([...args]);
    const response = this.responses.get(JSON.stringify(args));
    if (!response) throw new Error(`Unexpected fake gh command: ${JSON.stringify(args)}`);
    return response;
  }
  respond(args: readonly string[], result: GhCommandResult): void {
    this.responses.set(JSON.stringify(args), result);
  }
  json(path: string, body: unknown, status = 200, eol = '\r\n'): void {
    this.respond(['api', '--include', path], http(status, JSON.stringify(body), eol));
  }
  pages(path: string, pages: unknown): void {
    this.respond(['api', '--paginate', '--slurp', path], {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(pages)),
      stderr: '',
    });
  }
}
function http(
  status: number,
  body: string | Uint8Array,
  eol = '\r\n',
  extraHeaders = ''
): GhCommandResult {
  return {
    exitCode: status >= 400 ? 1 : 0,
    stdout: Buffer.concat([
      Buffer.from(
        `HTTP/2.0 ${status} Status${eol}Content-Type: application/json${eol}${extraHeaders}${eol}`
      ),
      typeof body === 'string' ? Buffer.from(body) : Buffer.from(body),
    ]),
    stderr: 'transport credential must not be echoed',
  };
}
const BASE = 'repos/owner/repo';
const SHA = 'a'.repeat(40);
const TAG = 'b'.repeat(40);
function fixture() {
  const runner = new FakeGhRunner();
  return { runner, client: new CanaryGitHub('owner/repo', runner) };
}

test.each(['\n', '\r\n'])('retains actual release HTTP status using %j headers', async (eol) => {
  const { runner, client } = fixture();
  runner.json(`${BASE}/releases/tags/v1.0.0`, { id: 1 }, 200, eol);
  expect(await client.getRelease('v1.0.0')).toEqual({
    status: 200,
    body: { id: 1 },
  });
  runner.json(`${BASE}/releases/tags/absent`, { message: 'Not Found' }, 404, eol);
  runner.pages(`${BASE}/releases?per_page=100`, [[]]);
  expect(await client.getRelease('absent')).toEqual({
    status: 404,
    body: { message: 'Not Found' },
  });
});
test('finds an interrupted tagless draft on later release pages after a published lookup404', async () => {
  const { runner, client } = fixture();
  const draft = {
    id: 33,
    tag_name: 'v1.0.0',
    draft: true,
    target_commitish: SHA,
  };
  runner.json(`${BASE}/releases/tags/v1.0.0`, { message: 'Not Found' }, 404);
  runner.pages(`${BASE}/releases?per_page=100`, [
    [{ id: 1, tag_name: 'v0.9.0', draft: false }],
    [draft],
  ]);
  expect(await client.getRelease('v1.0.0')).toEqual({
    status: 200,
    body: draft,
  });
  expect(runner.calls).toEqual([
    ['api', '--include', `${BASE}/releases/tags/v1.0.0`],
    ['api', '--paginate', '--slurp', `${BASE}/releases?per_page=100`],
  ]);
});

test('does not choose an arbitrary release when pending tags are duplicated', async () => {
  const { runner, client } = fixture();
  runner.json(`${BASE}/releases/tags/v1.0.0`, { message: 'Not Found' }, 404);
  runner.pages(`${BASE}/releases?per_page=100`, [
    [{ id: 1, tag_name: 'v1.0.0', draft: true }],
    [{ id: 2, tag_name: 'v1.0.0', draft: true }],
  ]);
  await expect(client.getRelease('v1.0.0')).rejects.toThrow('Ambiguous GitHub release tag');
});

test('retains positive published metadata from the list instead of inventing absence', async () => {
  const { runner, client } = fixture();
  const release = { id: 33, tag_name: 'v1.0.0', draft: false };
  runner.json(`${BASE}/releases/tags/v1.0.0`, { message: 'Not Found' }, 404);
  runner.pages(`${BASE}/releases?per_page=100`, [[release]]);
  expect(await client.getRelease('v1.0.0')).toEqual({
    status: 200,
    body: release,
  });
});

test.each([200, 401, 403, 429, 500, 503])(
  'only an actual404 triggers draft lookup; HTTP%i',
  async (status) => {
    const { runner, client } = fixture();
    const body = status === 200 ? { id: 33 } : { message: 'fixture denied read' };
    runner.json(`${BASE}/releases/tags/v1.0.0`, body, status);
    expect(await client.getRelease('v1.0.0')).toEqual({ status, body });
    expect(runner.calls).toEqual([['api', '--include', `${BASE}/releases/tags/v1.0.0`]]);
  }
);

test.each([
  { pages: [], message: 'expected nonempty array of pages' },
  { pages: [{}], message: 'expected complete array collection' },
  { pages: [[null]], message: 'GitHub release listing entry: expected object' },
  {
    pages: [[{ id: 1, draft: true }]],
    message: 'expected tag_name string and draft boolean',
  },
  {
    pages: [[{ id: 1, tag_name: 'other' }]],
    message: 'expected tag_name string and draft boolean',
  },
  {
    pages: [[{ id: 1, tag_name: 42, draft: true }]],
    message: 'expected tag_name string and draft boolean',
  },
  {
    pages: [[{ id: 1, tag_name: '', draft: false }]],
    message: 'expected tag_name string and draft boolean',
  },
  {
    pages: [[{ id: 1, tag_name: 'other', draft: 'true' }]],
    message: 'expected tag_name string and draft boolean',
  },
  {
    pages: [[{ tag_name: 'other', draft: false }]],
    message: 'Invalid release listing ID: expected positive safe integer',
  },
  {
    pages: [[{ id: 0, tag_name: 'other', draft: false }]],
    message: 'Invalid paginated entry ID: expected positive safe integer',
  },
  {
    pages: [
      [{ id: 1, tag_name: 'other', draft: false }],
      [{ id: 1, tag_name: 'v1.0.0', draft: true }],
    ],
    message: 'Duplicate GitHub paginated entry ID',
  },
])(
  'malformed or repeated release pages cannot establish absence: %j',
  async ({ pages, message }) => {
    const { runner, client } = fixture();
    runner.json(`${BASE}/releases/tags/v1.0.0`, { message: 'Not Found' }, 404);
    runner.pages(`${BASE}/releases?per_page=100`, pages);
    await expect(client.getRelease('v1.0.0')).rejects.toThrow(message);
  }
);

test('a failed draft listing cannot become successful absence', async () => {
  const { runner, client } = fixture();
  runner.json(`${BASE}/releases/tags/v1.0.0`, { message: 'Not Found' }, 404);
  runner.respond(['api', '--paginate', '--slurp', `${BASE}/releases?per_page=100`], {
    exitCode: 1,
    stdout: Buffer.from('[]'),
    stderr: 'fixture denied draft visibility',
  });
  await expect(client.getRelease('v1.0.0')).rejects.toThrow(
    'GitHub paginated read: expected successful gh exit'
  );
});

test('supports gh mixed LF status and CRLF headers observed in hosted reads', async () => {
  const { runner, client } = fixture();
  const result = http(200, '{}');
  runner.respond(['api', '--include', `${BASE}/test`], {
    ...result,
    stdout: Buffer.from(Buffer.from(result.stdout).toString().replace('Status\r\n', 'Status\n')),
  });
  expect(await client.getJson(`${BASE}/test`)).toEqual({
    status: 200,
    body: {},
  });
});
test.each([401, 403, 429, 500, 503])(
  'preserves genuine HTTP %i without inventing absence',
  async (status) => {
    const { runner, client } = fixture();
    runner.json(`${BASE}/test`, { message: 'request rejected' }, status);
    expect((await client.getJson(`${BASE}/test`)).status).toBe(status);
  }
);
test.each([
  '',
  'garbage',
  'HTTP/2.0 200 OK\npartial header',
  'HTTP/2.0 200 OK\nBrokenHeader\n\n{}',
  'HTTP/2.0 200 OK\nContent-Length: 20\n\n{}',
  'HTTP/2.0 200 OK\nContent-Length: bad\n\n{}',
  'HTTP/2.0 200 OK\nContent-Length: 2\nContent-Length: 2\n\n{}',
])('refuses malformed or incomplete HTTP framing %j', async (output) => {
  const { runner, client } = fixture();
  runner.respond(['api', '--include', `${BASE}/test`], {
    exitCode: 0,
    stdout: Buffer.from(output),
    stderr: 'secret',
  });
  await expect(client.getJson(`${BASE}/test`)).rejects.toThrow();
});
test('validates actual response length when supplied', async () => {
  const { runner, client } = fixture();
  runner.respond(
    ['api', '--include', `${BASE}/test`],
    http(200, '{}', '\r\n', 'Content-Length: 2\r\n')
  );
  expect((await client.getJson(`${BASE}/test`)).body).toEqual({});
});
test.each([
  { status: 200, exitCode: 1 },
  { status: 404, exitCode: 0 },
])('rejects inconsistent HTTP/CLI result %j', async (item) => {
  const { runner, client } = fixture();
  runner.respond(['api', '--include', `${BASE}/test`], {
    ...http(item.status, '{}'),
    exitCode: item.exitCode,
  });
  await expect(client.getJson(`${BASE}/test`)).rejects.toThrow('inconsistent HTTP');
});
test('network failure never exposes CLI credentials or becomes404', async () => {
  const { runner, client } = fixture();
  runner.respond(['api', '--include', `${BASE}/test`], {
    exitCode: 1,
    stdout: new Uint8Array(),
    stderr: 'secret bearer token',
  });
  await expect(client.getJson(`${BASE}/test`)).rejects.toThrow('expected HTTP status headers');
});
test('refuses malformed JSON after valid HTTP headers', async () => {
  const { runner, client } = fixture();
  runner.respond(['api', '--include', `${BASE}/test`], http(200, 'not JSON'));
  await expect(client.getJson(`${BASE}/test`)).rejects.toThrow('expected valid JSON');
});
test.each([
  'other/repo/path',
  'repos/other/repo/path',
  'repos/owner/repo/../else',
  'repos/owner/repo/./else',
  'repos/owner/repo/path#fragment',
  'repos/owner/repo/path\nheader',
  'repos/owner/repo/path\\else',
])('rejects nonrepository API path %j before IO', async (path) => {
  const { runner, client } = fixture();
  await expect(client.getJson(path)).rejects.toThrow('expected path inside repos/owner/repo');
  expect(runner.calls).toHaveLength(0);
});
test.each(['owner', 'owner/repo/other', 'owner\n/repo', 'https://github.com/owner/repo'])(
  'rejects invalid repository %j',
  (repository) => {
    expect(() => new CanaryGitHub(repository)).toThrow('expected owner/repository');
  }
);
test('encodes release and tag names as single endpoint path values', async () => {
  const { runner, client } = fixture();
  runner.json(`${BASE}/releases/tags/release%2Fcanary`, { id: 1 });
  await client.getRelease('release/canary');
  expect(runner.calls[0]).toEqual(['api', '--include', `${BASE}/releases/tags/release%2Fcanary`]);
});
test('reads every release asset page and rejects duplicate IDs', async () => {
  const { runner, client } = fixture();
  const path = `${BASE}/releases/1/assets?per_page=100`;
  runner.pages(path, [[{ id: 1 }], [{ id: 2 }]]);
  expect(await client.listAssets(1)).toEqual([{ id: 1 }, { id: 2 }]);
  runner.pages(path, [[{ id: 1 }], [{ id: 1 }]]);
  await expect(client.listAssets(1)).rejects.toThrow('Duplicate GitHub paginated entry ID: 1');
});
test.each([[], {}, [{}], [null], [[{ id: 0 }]]].map((pages) => ({ pages })))(
  'rejects invalid array pages %j',
  async ({ pages }) => {
    const { runner, client } = fixture();
    runner.pages(`${BASE}/test`, pages);
    await expect(client.list(`${BASE}/test`)).rejects.toThrow();
  }
);
test('supports a genuinely empty list page', async () => {
  const { runner, client } = fixture();
  runner.pages(`${BASE}/test`, [[]]);
  expect(await client.list(`${BASE}/test`)).toEqual([]);
});
test('validates complete counted collections across pages', async () => {
  const { runner, client } = fixture();
  runner.pages(`${BASE}/test`, [
    { total_count: 2, jobs: [{ id: 1 }] },
    { total_count: 2, jobs: [{ id: 2 }] },
  ]);
  expect(await client.list(`${BASE}/test`, 'jobs')).toEqual([{ id: 1 }, { id: 2 }]);
});
test.each(
  [
    [{ jobs: [] }],
    [{ total_count: 1, jobs: [] }],
    [{ total_count: -1, jobs: [] }],
    [{ total_count: 0, jobs: {} }],
    [
      { total_count: 1, jobs: [{ id: 1 }] },
      { total_count: 2, jobs: [] },
    ],
  ].map((page) => ({ page }))
)('rejects incomplete counted collection %j', async ({ page }) => {
  const { runner, client } = fixture();
  runner.pages(`${BASE}/test`, page);
  await expect(client.list(`${BASE}/test`, 'jobs')).rejects.toThrow();
});
test('pagination CLI and JSON failures do not become empty lists', async () => {
  const { runner, client } = fixture();
  const args = ['api', '--paginate', '--slurp', `${BASE}/test`];
  runner.respond(args, {
    exitCode: 1,
    stdout: Buffer.from('[]'),
    stderr: 'secret',
  });
  await expect(client.list(`${BASE}/test`)).rejects.toThrow('expected successful gh exit');
  runner.respond(args, {
    exitCode: 0,
    stdout: Buffer.from('broken'),
    stderr: '',
  });
  await expect(client.list(`${BASE}/test`)).rejects.toThrow('expected JSON page collection');
});
test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid release/asset ID %i before IO',
  async (id) => {
    const { runner, client } = fixture();
    await expect(client.listAssets(id)).rejects.toThrow('positive safe integer');
    await expect(client.readAsset(id)).rejects.toThrow('positive safe integer');
    expect(runner.calls).toHaveLength(0);
  }
);
test('reads binary evidence assets without decoding bytes as text', async () => {
  const { runner, client } = fixture();
  const bytes = new Uint8Array([0, 255, 13, 10, 10, 128]);
  runner.respond(
    [
      'api',
      '--include',
      '--header',
      'Accept: application/octet-stream',
      `${BASE}/releases/assets/1`,
    ],
    http(200, bytes)
  );
  expect(await client.readAsset(1)).toEqual({ status: 200, body: bytes });
});
test('returns actual404 for missing asset evidence', async () => {
  const { runner, client } = fixture();
  runner.respond(
    [
      'api',
      '--include',
      '--header',
      'Accept: application/octet-stream',
      `${BASE}/releases/assets/1`,
    ],
    http(404, '{"message":"Not Found"}')
  );
  expect((await client.readAsset(1)).status).toBe(404);
});
test('peels lightweight and annotated tags to exact full commit SHA', async () => {
  const { runner, client } = fixture();
  runner.json(`${BASE}/git/ref/tags/v1`, {
    object: { type: 'commit', sha: SHA },
  });
  expect(await client.resolveTag('v1')).toEqual({ status: 200, body: SHA });
  runner.json(`${BASE}/git/ref/tags/v2`, { object: { type: 'tag', sha: TAG } });
  runner.json(`${BASE}/git/tags/${TAG}`, {
    object: { type: 'commit', sha: SHA },
  });
  expect(await client.resolveTag('v2')).toEqual({ status: 200, body: SHA });
});
test('only actual absent tag ref returns404', async () => {
  const { runner, client } = fixture();
  runner.json(`${BASE}/git/ref/tags/absent`, { message: 'Not Found' }, 404);
  expect((await client.resolveTag('absent')).status).toBe(404);
  runner.json(`${BASE}/git/ref/tags/failed`, { message: 'Forbidden' }, 403);
  await expect(client.resolveTag('failed')).rejects.toThrow('expected HTTP200');
  runner.json(`${BASE}/git/ref/tags/missing-inner`, {
    object: { type: 'tag', sha: TAG },
  });
  runner.json(`${BASE}/git/tags/${TAG}`, { message: 'Not Found' }, 404);
  await expect(client.resolveTag('missing-inner')).rejects.toThrow(
    'annotated tag: expected HTTP200'
  );
});
test.each([
  {},
  null,
  { object: {} },
  { object: { type: 'commit', sha: 'abcdef0' } },
  { object: { type: 'tree', sha: SHA } },
])('rejects malformed tag metadata %j', async (body) => {
  const { runner, client } = fixture();
  runner.json(`${BASE}/git/ref/tags/v1`, body);
  await expect(client.resolveTag('v1')).rejects.toThrow();
});
test('refuses cyclic and unbounded tag chains', async () => {
  const { runner, client } = fixture();
  runner.json(`${BASE}/git/ref/tags/cycle`, {
    object: { type: 'tag', sha: TAG },
  });
  runner.json(`${BASE}/git/tags/${TAG}`, { object: { type: 'tag', sha: TAG } });
  await expect(client.resolveTag('cycle')).rejects.toThrow('Cyclic annotated tag');
  runner.json(`${BASE}/git/ref/tags/deep`, {
    object: { type: 'tag', sha: '0'.repeat(40) },
  });
  for (let depth = 0; depth < 8; depth += 1) {
    runner.json(`${BASE}/git/tags/${String(depth).repeat(40)}`, {
      object: { type: 'tag', sha: String(depth + 1).repeat(40) },
    });
  }
  await expect(client.resolveTag('deep')).rejects.toThrow('depth exceeds8');
});
test('writes through the owned runner and rejects failure without echoing secret output', () => {
  const { runner, client } = fixture();
  const args = ['release', 'upload', 'v1', 'asset', '--repo', 'owner/repo'];
  const result = { exitCode: 0, stdout: Buffer.from('uploaded'), stderr: '' };
  runner.respond(args, result);
  expect(client.writeCommand(args)).toBe(result);
  runner.respond(args, {
    exitCode: 1,
    stdout: new Uint8Array(),
    stderr: 'secret bearer token',
  });
  expect(() => client.writeCommand(args)).toThrow('expected exit0; received 1');
  expect(() => client.writeCommand([])).toThrow('expected nonempty argument list');
});
test('a failed write surfaces only the HTTP status from gh stderr', () => {
  const { runner, client } = fixture();
  const args = ['release', 'create', 'v1', '--repo', 'owner/repo'];
  runner.respond(args, {
    exitCode: 1,
    stdout: new Uint8Array(),
    stderr: 'HTTP 422: Validation Failed (https://api.github.com/x?token=secret-value)',
  });
  expect(() => client.writeCommand(args)).toThrow('expected exit0; received 1 (HTTP 422)');
  expect(() => client.writeCommand(args)).not.toThrow(/secret-value|Validation Failed/);
});

test('reads generic Actions binary bytes with exact HTTP status', async () => {
  const { runner, client } = fixture();
  const path = `${BASE}/actions/artifacts/5/zip`;
  const bytes = new Uint8Array([0, 255, 1]);
  runner.respond(['api', '--include', path], http(200, bytes));
  expect(await client.readBytes(path)).toEqual({ status: 200, body: bytes });
  runner.respond(
    ['api', '--include', '--header', 'Accept: application/octet-stream', path],
    http(404, '{}')
  );
  expect((await client.readBytes(path, 'application/octet-stream')).status).toBe(404);
  await expect(client.readBytes('repos/other/repo/file')).rejects.toThrow('expected path inside');
});

test('reads the repository root endpoint for stable repository ID association', async () => {
  const { runner, client } = fixture();
  runner.json(BASE, { id: 123, full_name: 'owner/repo' });
  expect(await client.getJson(BASE)).toEqual({
    status: 200,
    body: { id: 123, full_name: 'owner/repo' },
  });
});
