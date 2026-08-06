import type {
  EnvironmentTransportConfig,
  EnvironmentTransportKind,
} from '@mangostudio/shared/environments';
import {
  ContainerEnvironmentConfigSchema,
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
  container: ContainerEnvironmentConfigSchema,
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

type EnvironmentConfigByKind = {
  [K in EnvironmentTransportKind]: Extract<
    EnvironmentTransportConfig,
    { transportKind: K }
  >['config'];
};

/**
 * Validates a stored config and narrows it to the shape its transport kind
 * implies, so transport launchers read typed fields instead of casting the
 * `unknown` a database row carries.
 */
export function environmentConfigFor<K extends EnvironmentTransportKind>(
  transportKind: K,
  config: unknown
): EnvironmentConfigByKind[K] {
  assertEnvironmentConfig(transportKind, config);
  // The assertion narrows to the union of every kind's config; only the caller's
  // `transportKind` says which arm that is.
  return config as EnvironmentConfigByKind[K];
}
