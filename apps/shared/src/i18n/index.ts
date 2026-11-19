import { messages as core } from './en';
import { messages as environments } from './en-environments';
import { messages as git } from './en-git';
import { messages as github } from './en-github';
import { messages as library } from './en-library';
import { messages as onboarding } from './en-onboarding';
import { messages as settings } from './en-settings';
import type { Messages } from './types';

/**
 * The complete English dictionary, deferred namespaces included. The frontend
 * never imports this value (it would put the deferred namespaces back in the
 * entry chunk); it exists for tests and tooling that read every key.
 */
export const en: Messages = {
  ...core,
  ...settings,
  ...onboarding,
  // A feature namespace is split across `en.ts` and `en-<namespace>.ts`: join its halves.
  environments: { ...core.environments, ...environments.environments },
  git: { ...core.git, ...git.git },
  github: { ...core.github, ...github.github },
  library: { ...core.library, ...library.library },
};
export { messages as ptBR } from './pt-BR';
export type {
  CoreMessages,
  DeferredNamespace,
  FeatureMessages,
  FeatureNamespace,
  Locale,
  LoadedMessages,
  Messages,
} from './types';

/** Locale padrão da aplicação. */
export const defaultLocale = 'en' as const;
