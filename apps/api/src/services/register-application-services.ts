import { registerProviders } from './providers/register-providers';
import { registerRealtimeBus } from './realtime/realtime-bus';
import { registerTools } from './tools/register-tools';

/**
 * Registers all runtime service implementations (providers, tools, realtime bus)
 * at startup. Idempotent: keyed registries and the bus singleton tolerate
 * repeated calls — the test preload plus the app bootstrap, or a re-register
 * after clearRegistry() in tests — are harmless.
 * // Usage: registerApplicationServices()
 */
export function registerApplicationServices(): void {
  registerProviders();
  registerTools();
  registerRealtimeBus();
}
