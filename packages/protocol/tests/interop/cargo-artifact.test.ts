import { describe, expect, it } from 'bun:test';
import { peerExecutable } from './cargo-artifact';

const artifact = {
  reason: 'compiler-artifact',
  target: { name: 'conformance_peer', kind: ['example'] },
  executable: '/build/out/debug/examples/conformance_peer',
  fresh: false,
};

const unrelatedMessages: unknown[] = [
  { reason: 'compiler-message', target: artifact.target },
  { ...artifact, target: { name: 'conformance_peer', kind: ['lib'] } },
  { ...artifact, target: { name: 'another_peer', kind: ['example'] } },
  { ...artifact, target: { name: 'conformance_peer', kind: 'example' } },
  { ...artifact, target: null },
  {},
];

describe('Cargo peer build receipt', () => {
  it.each([
    '/build/out/debug/examples/conformance_peer',
    '/build/out/custom-triple/custom-profile/examples/conformance_peer',
    'D:\\agents\\build out\\debug\\examples\\conformance_peer.exe',
  ])('retains the exact executable path %s', (executable) => {
    const output = [
      'a procedural macro diagnostic',
      JSON.stringify({ ...artifact, target: { name: 'another_peer', kind: ['example'] } }),
      JSON.stringify({ reason: 'build-script-executed', executable: '/unrelated/tool' }),
      JSON.stringify({ ...artifact, executable }),
      JSON.stringify({ reason: 'build-finished', success: true }),
      '',
    ].join('\n');
    expect(peerExecutable(output)).toBe(executable);
  });

  it('uses cached compiler artifacts and accepts repeated identical receipts', () => {
    const receipt = JSON.stringify({ ...artifact, fresh: true });
    expect(peerExecutable(`${receipt}\n${receipt}`)).toBe(artifact.executable);
  });

  it.each([null, '', 42])('rejects invalid executable %j', (executable) => {
    expect(() => peerExecutable(JSON.stringify({ ...artifact, executable }))).toThrow(
      `Cargo reported executable ${JSON.stringify(executable)}; expected a nonempty conformance_peer example executable path`
    );
  });

  it.each(unrelatedMessages)('requires a matching example compiler artifact: %j', (message) => {
    expect(() => peerExecutable(JSON.stringify(message))).toThrow(
      'Cargo reported executable paths []; expected exactly one conformance_peer example executable'
    );
  });

  it('reports a missing artifact', () => {
    expect(() => peerExecutable('')).toThrow(
      'Cargo reported executable paths []; expected exactly one conformance_peer example executable'
    );
  });

  it('reports the invalid JSON message instead of guessing a path', () => {
    expect(() => peerExecutable('{broken')).toThrow(
      'Cargo reported "{broken"; expected a JSON build message'
    );
  });

  it('rejects ambiguous executable paths', () => {
    const other = { ...artifact, executable: '/different/conformance_peer' };
    expect(() => peerExecutable(`${JSON.stringify(artifact)}\n${JSON.stringify(other)}`)).toThrow(
      `Cargo reported executable paths ${JSON.stringify([artifact.executable, other.executable])}; expected exactly one conformance_peer example executable`
    );
  });
});
