import { describe, expect, it } from 'bun:test';
import { assertCatalog, type Catalog, isCatalog } from '../src/schemas/catalog';
import {
  isReservedMethodName,
  isValidMethodName,
  METHOD_PATTERN,
  RPC_RESERVED_PREFIX,
} from '../src/schemas/common';
import { assertFrame, type Frame, isFrame } from '../src/schemas/frames';
import { refusalOf } from './support/refusal';

describe('isValidMethodName', () => {
  it('accepts the grammar of §6.1', () => {
    expect(isValidMethodName('a.b')).toBe(true);
    expect(isValidMethodName('fs.read-file')).toBe(true);
    expect(isValidMethodName('runtime.update.begin-transfer')).toBe(true);
    expect(isValidMethodName('rpc.discover')).toBe(true);
  });

  it('refuses a name the grammar does not produce', () => {
    expect(isValidMethodName('fs')).toBe(false);
    expect(isValidMethodName('Fs.read')).toBe(false);
    expect(isValidMethodName('fs..read')).toBe(false);
    expect(isValidMethodName('fs.read-')).toBe(false);
    expect(isValidMethodName('1fs.read')).toBe(false);
    expect(isValidMethodName('fs.read file')).toBe(false);
  });

  it('refuses a name over 128 characters that the pattern alone would accept', () => {
    const long = `a.${'b'.repeat(127)}`;

    expect(long.length).toBe(129);
    expect(METHOD_PATTERN.test(long)).toBe(true);
    expect(isValidMethodName(long)).toBe(false);
  });
});

describe('isReservedMethodName', () => {
  it('holds the rpc. segment and nothing else', () => {
    expect(RPC_RESERVED_PREFIX).toBe('rpc.');
    expect(isReservedMethodName('rpc.discover')).toBe(true);
    expect(isReservedMethodName('rpcs.discover')).toBe(false);
    expect(isReservedMethodName('fs.rpc.read')).toBe(false);
  });
});

describe('isFrame', () => {
  it('accepts each of the nine frame types', () => {
    const frames: Frame[] = [
      {
        type: 'hello',
        protocol: { major: 1, minor: 0 },
        peer: { name: 'fixture', version: '0.0.0', role: 'tool' },
        capabilities: {},
      },
      { type: 'req', id: 'r-1', method: 'a.b', params: {} },
      { type: 'res', id: 'r-1', result: null },
      { type: 'err', id: 'r-1', error: { code: 'INTERNAL', message: 'boom' } },
      { type: 'evt', topic: 'a.b', seq: 0, payload: null },
      { type: 'cancel', id: 'r-1' },
      { type: 'ping' },
      { type: 'pong' },
      { type: 'close', code: 4000 },
    ];

    for (const frame of frames) expect(isFrame(frame)).toBe(true);
    expect(frames).toHaveLength(9);
  });

  it('ignores unknown members at every level, as §4 requires', () => {
    expect(isFrame({ type: 'ping', 'x-at': 123 })).toBe(true);
    expect(
      isFrame({
        type: 'hello',
        protocol: { major: 1, minor: 0, future: 1 },
        peer: { name: 'f', version: '0', role: 'tool', extra: true },
        capabilities: { fsRead: true },
        'x-vendor': { trace: 'abc' },
      })
    ).toBe(true);
  });

  it('refuses a value that is not one of the nine frames', () => {
    expect(isFrame({})).toBe(false);
    expect(isFrame({ type: 'nope' })).toBe(false);
    expect(isFrame([])).toBe(false);
    expect(isFrame(null)).toBe(false);
    expect(isFrame('req')).toBe(false);
  });
});

describe('assertFrame', () => {
  it('returns quietly for a frame', () => {
    expect(() => assertFrame({ type: 'ping' })).not.toThrow();
  });

  it('names the failing member, the rule and the value received', () => {
    const error = refusalOf(() =>
      assertFrame({ type: 'req', id: 'r', method: 'Fs.read', params: {} })
    );

    expect(error.kind).toBe('schema');
    expect(error.message).toContain('/method');
    expect(error.message).toContain('must match pattern');
    expect(error.message).toContain(
      'received {"type":"req","id":"r","method":"Fs.read","params":{}}'
    );
  });

  it('reports the root when the frame carries no type at all', () => {
    const error = refusalOf(() => assertFrame({}));

    expect(error.message).toContain('(root)');
    expect(error.message).toContain('received {}');
    expect(error.frameType).toBeUndefined();
  });

  it('lists the nine types when the type member is unknown', () => {
    const error = refusalOf(() => assertFrame({ type: 'nope' }));

    expect(error.message).toContain('unknown frame type "nope"');
    expect(error.message).toContain('hello, req, res, err, evt, cancel, ping, pong, close');
    expect(error.frameType).toBe('nope');
  });

  it('carries the frame type of a hello that failed the schema', () => {
    const error = refusalOf(() =>
      assertFrame({
        type: 'hello',
        protocol: { major: 1, minor: 0 },
        peer: { name: 'fixture', version: '0.0.0', role: 'Runtime' },
        capabilities: {},
      })
    );

    expect(error.frameType).toBe('hello');
    expect(error.message).toContain('/peer/role');
  });

  it('truncates a long value rather than quoting the whole frame', () => {
    const error = refusalOf(() =>
      assertFrame({ type: 'req', id: 'r', method: 'A.b', params: { blob: 'x'.repeat(500) } })
    );

    expect(error.message).toContain('…');
    expect(error.message.length).toBeLessThan(300);
  });
});

describe('catalog documents', () => {
  const catalog: Catalog = {
    name: 'fixture-contract',
    version: '1.0.0',
    protocol: { major: 1, minor: 0 },
    methods: [{ name: 'text.echo', params: { type: 'object' }, result: { type: 'object' } }],
    events: [{ topic: 'text.stream', payload: { type: 'object' }, stream: true }],
    capabilities: { type: 'object' },
  };

  it('accepts a catalog with every optional member and one with none', () => {
    expect(isCatalog(catalog)).toBe(true);
    expect(isCatalog({ name: 'x', version: '1', methods: [] })).toBe(true);
  });

  it('refuses a single-segment method name and a missing member', () => {
    expect(
      isCatalog({ name: 'x', version: '1', methods: [{ name: 'bad', params: {}, result: {} }] })
    ).toBe(false);
    expect(isCatalog({ name: 'x', version: '1' })).toBe(false);
    expect(isCatalog({ name: 'x', version: '1', methods: [{ name: 'a.b', params: {} }] })).toBe(
      false
    );
  });

  it('still validates the protocol member it carries a description on', () => {
    expect(
      isCatalog({ name: 'x', version: '1', methods: [], protocol: { major: 1, minor: 0 } })
    ).toBe(true);
    expect(
      isCatalog({ name: 'x', version: '1', methods: [], protocol: { major: 0, minor: 0 } })
    ).toBe(false);
    expect(isCatalog({ name: 'x', version: '1', methods: [], protocol: { major: 1 } })).toBe(false);
  });

  it('assertCatalog names the failing path', () => {
    const error = refusalOf(() =>
      assertCatalog({ name: 'x', version: '1', methods: [{ name: 'bad', params: {}, result: {} }] })
    );

    expect(error.kind).toBe('schema');
    expect(error.message).toContain('/methods/0/name');
    expect(error.message).toContain('must match pattern');
  });

  it('assertCatalog returns quietly for a catalog', () => {
    expect(() => assertCatalog(catalog)).not.toThrow();
  });
});
