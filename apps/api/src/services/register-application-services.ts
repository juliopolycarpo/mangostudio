import { registerProviders } from './providers/register-providers';
import { registerTools } from './tools/register-tools';

let registered = false;

/** Registers runtime service implementations. // Usage: registerApplicationServices() */
export function registerApplicationServices(): void {
  if (registered) {
    // Double-registration is allowed (e.g. after clearRegistry in tests)
    // but worth flagging: it signals that the preload or startup might be
    // calling this after a test already cleared the registries.
    if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
      console.warn(
        'registerApplicationServices() called more than once. ' +
          'Providers and tools are already registered.'
      );
    }
  }
  registered = true;

  registerProviders();
  registerTools();
}
