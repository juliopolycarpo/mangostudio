import { registerProviders } from './providers/register-providers';
import { registerTools } from './tools/register-tools';

/**
 * Registers all runtime service implementations (providers + tools) at startup.
 * Idempotent: both registries are keyed maps, so repeated calls — the test
 * preload plus the app bootstrap, or a re-register after clearRegistry() in
 * tests — are harmless.
 * // Usage: registerApplicationServices()
 */
export function registerApplicationServices(): void {
  registerProviders();
  registerTools();
}
