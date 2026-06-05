import { registerProviders } from './providers/register-providers';
import { registerTools } from './tools/register-tools';

/** Registers runtime service implementations. // Usage: registerApplicationServices() */
export function registerApplicationServices(): void {
  registerProviders();
  registerTools();
}
