import { describe, expect, it } from 'bun:test';
import negotiation from '../../../spec/fixtures/1/negotiation.json';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_REASON,
  Session,
  type SessionOptions,
} from '../src/session';
import { createInProcessPortPair } from '../src/transports/in-process';
import { negotiate, type ProtocolVersion } from '../src/version';

interface NegotiationCase {
  readonly name: string;
  readonly local: ProtocolVersion;
  readonly remote: ProtocolVersion;
  readonly expected: {
    readonly effectiveMinor?: number;
    readonly mismatch?: boolean;
    readonly closeCode?: number;
  };
}

const cases = negotiation.cases as readonly NegotiationCase[];

describe('negotiation corpus', () => {
  it('reads every case of spec/fixtures/1/negotiation.json', () => {
    expect(cases.length).toBeGreaterThan(5);
  });

  for (const item of cases) {
    it(`negotiates ${item.name}`, () => {
      const result = negotiate(item.local, item.remote);

      if (item.expected.mismatch === true) {
        expect(result).toEqual({ ok: false, closeCode: 4426 });
        expect(item.expected.closeCode).toBe(4426);
        return;
      }
      expect(result).toEqual({ ok: true, effectiveMinor: item.expected.effectiveMinor as number });
    });
  }
});

describe('handshake budget', () => {
  const HUB: SessionOptions['peer'] = { name: 'hub', version: '1.0.0', role: 'hub' };

  it('defaults to the budget the corpus records', () => {
    expect(DEFAULT_HANDSHAKE_TIMEOUT_MS).toBe(negotiation.handshake.timeoutMs);
  });

  it('closes a silent peer with the corpus code and reason', async () => {
    const ports = createInProcessPortPair();
    const session = new Session(ports.a, {
      peer: HUB,
      handshakeTimeoutMs: 20,
      livenessIntervalMs: false,
    });
    await session.ready.catch(() => undefined);
    expect(session.closure).toMatchObject({
      code: negotiation.handshake.closeCode,
      reason: negotiation.handshake.reason,
    });
    expect(HANDSHAKE_TIMEOUT_REASON).toBe(negotiation.handshake.reason);
  });
});
