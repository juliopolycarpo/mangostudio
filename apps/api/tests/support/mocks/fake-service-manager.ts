import type { UserServiceDefinition, UserServiceManager } from '@mangostudio/runtime';
import type { UserServiceStatus } from '@mangostudio/shared/runtime-home';

/**
 * In-memory service manager: records every verb, hands back a scripted
 * status, and can be told to refuse. No supervisor is ever contacted.
 */
export class FakeServiceManager implements UserServiceManager {
  readonly calls: string[] = [];
  readonly installed: UserServiceDefinition[] = [];
  readonly unitPath: string | null = '/home/test/.config/systemd/user/mangostudio.service';
  failWith: Error | null = null;
  /** Fails only the install call, leaving `status()` scripted as usual. */
  installFailWith: Error | null = null;
  /** The same seam for `uninstall`: a supervisor refuses each verb separately. */
  uninstallFailWith: Error | null = null;

  constructor(private statusValue: UserServiceStatus = notInstalled()) {}

  setStatus(status: Partial<UserServiceStatus>): void {
    this.statusValue = { ...this.statusValue, ...status };
  }

  install(definition: UserServiceDefinition): Promise<void> {
    this.calls.push('install');
    this.installed.push(definition);
    if (this.installFailWith) return Promise.reject(this.installFailWith);
    return this.settle();
  }

  uninstall(): Promise<void> {
    this.calls.push('uninstall');
    if (this.uninstallFailWith) return Promise.reject(this.uninstallFailWith);
    return this.settle();
  }

  status(): Promise<UserServiceStatus> {
    this.calls.push('status');
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(this.statusValue);
  }

  start(): Promise<void> {
    this.calls.push('start');
    return this.settle();
  }

  stop(): Promise<void> {
    this.calls.push('stop');
    return this.settle();
  }

  restart(): Promise<void> {
    this.calls.push('restart');
    return this.settle();
  }

  readUnit(): Promise<string | null> {
    return Promise.resolve(null);
  }

  private settle(): Promise<void> {
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve();
  }
}

function notInstalled(): UserServiceStatus {
  return {
    schemaVersion: 1,
    platform: 'linux',
    unitName: 'mangostudio.service',
    installed: false,
    enabled: false,
    running: false,
  };
}

export function installedAndRunning(): UserServiceStatus {
  return { ...notInstalled(), installed: true, enabled: true, running: true, linger: true };
}
