import { describe, expect, it } from 'bun:test';
import {
  evaluateInstallGuard,
  evaluateRemoteInstallGuard,
  type InstallGuardContext,
  isLoopbackAddress,
} from '../../../../src/modules/environments/domain/install-guards';

const ALLOWED_CONTEXT: InstallGuardContext = {
  serverHost: '127.0.0.1',
  clientIp: '127.0.0.1',
  installsEnabled: true,
  standalone: false,
  container: false,
};

describe('install guards', () => {
  it.each([
    'localhost',
    'localhost.',
    '127.0.0.1',
    '127.42.0.9',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
  ])('recognizes loopback address %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '192.168.1.4',
    '::',
    '::ffff:192.168.1.4',
    'unknown',
    undefined,
  ])('rejects non-loopback address %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it('refuses a non-loopback bind outside standalone mode', () => {
    expect(evaluateInstallGuard({ ...ALLOWED_CONTEXT, serverHost: '0.0.0.0' })).toEqual({
      allowed: false,
      reasons: ['server-not-loopback'],
    });
  });

  it('lets standalone mode rely on the peer-address guard', () => {
    expect(
      evaluateInstallGuard({
        ...ALLOWED_CONTEXT,
        serverHost: '0.0.0.0',
        standalone: true,
      })
    ).toEqual({ allowed: true, reasons: [] });
  });

  it('refuses a non-loopback client', () => {
    expect(evaluateInstallGuard({ ...ALLOWED_CONTEXT, clientIp: '192.168.1.4' })).toEqual({
      allowed: false,
      reasons: ['client-not-loopback'],
    });
  });

  it('reports the container-specific reason', () => {
    expect(evaluateInstallGuard({ ...ALLOWED_CONTEXT, container: true })).toEqual({
      allowed: false,
      reasons: ['container'],
    });
  });

  it('requires explicit enablement', () => {
    expect(evaluateInstallGuard({ ...ALLOWED_CONTEXT, installsEnabled: false })).toEqual({
      allowed: false,
      reasons: ['disabled'],
    });
  });

  it('reports every failed condition instead of hiding later guards', () => {
    expect(
      evaluateInstallGuard({
        serverHost: '0.0.0.0',
        clientIp: '203.0.113.4',
        installsEnabled: false,
        standalone: false,
        container: true,
      })
    ).toEqual({
      allowed: false,
      reasons: ['container', 'server-not-loopback', 'client-not-loopback', 'disabled'],
    });
  });
});

describe('install guards for another machine', () => {
  it('refuses an environment nobody trusted, and names that side', () => {
    const guard = evaluateRemoteInstallGuard({ installsEnabled: true, allowInstalls: false });

    expect(guard).toEqual({ allowed: false, reasons: ['environment-not-trusted'] });
  });

  it('allows a trusted environment without asking anything about this machine', () => {
    // No loopback inputs exist here on purpose: whether the browser is at this
    // keyboard says nothing about a host somewhere else, and reusing that
    // verdict would refuse every remote install for the wrong reason.
    const guard = evaluateRemoteInstallGuard({ installsEnabled: true, allowInstalls: true });

    expect(guard).toEqual({ allowed: true, reasons: [] });
  });

  it('names both sides when the global switch is off as well', () => {
    const guard = evaluateRemoteInstallGuard({ installsEnabled: false, allowInstalls: false });

    expect(guard.reasons).toEqual(['environment-not-trusted', 'disabled']);
  });

  it('still refuses a trusted environment while installs are globally off', () => {
    const guard = evaluateRemoteInstallGuard({ installsEnabled: false, allowInstalls: true });

    expect(guard).toEqual({ allowed: false, reasons: ['disabled'] });
  });
});
