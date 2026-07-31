import type {
  EnvironmentTransportConfig,
  EnvironmentTransportKind,
} from '@mangostudio/shared/environments';
import {
  HttpEnvironmentConfigSchema,
  InProcessEnvironmentConfigSchema,
  SshEnvironmentConfigSchema,
  StdioEnvironmentConfigSchema,
  WebSocketEnvironmentConfigSchema,
  WslEnvironmentConfigSchema,
} from '@mangostudio/shared/environments';
import { Value } from '@sinclair/typebox/value';

const CONFIG_SCHEMAS = {
  'in-process': InProcessEnvironmentConfigSchema,
  stdio: StdioEnvironmentConfigSchema,
  wsl: WslEnvironmentConfigSchema,
  websocket: WebSocketEnvironmentConfigSchema,
  http: HttpEnvironmentConfigSchema,
  ssh: SshEnvironmentConfigSchema,
} as const;

export function isEnvironmentConfigValid(
  transportKind: EnvironmentTransportKind,
  config: unknown
): boolean {
  return Value.Check(CONFIG_SCHEMAS[transportKind], config);
}

export function assertEnvironmentConfig(
  transportKind: EnvironmentTransportKind,
  config: unknown
): asserts config is EnvironmentTransportConfig['config'] {
  if (!isEnvironmentConfigValid(transportKind, config)) {
    throw new Error(`Invalid ${transportKind} environment configuration.`);
  }
}
