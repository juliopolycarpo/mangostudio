import type { messages } from './pt-BR';

type DeepStringRecord<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringRecord<T[K]>;
};

/**
 * Messages type derived from the pt-BR dictionary (source of truth).
 * Verifies all keys exist but accepts any string value.
 * All locales must satisfy this type.
 */
export type Messages = DeepStringRecord<typeof messages>;

/**
 * Namespaces the frontend keeps out of the eager English dictionary and loads
 * with the route or flow that reads them. Both are read only behind a lazy
 * chunk (the settings routes, the setup flow); anything the first paint needs
 * belongs in an eager namespace instead.
 */
export type DeferredNamespace = 'settings' | 'onboarding';

/** What the eager dictionary holds: every namespace that is not deferred. */
export type CoreMessages = Omit<Messages, DeferredNamespace>;

/**
 * The messages a component may read once `Namespaces` are loaded: the eager
 * namespaces plus the named deferred ones. A deferred namespace that is not
 * named is absent from the type, so reading it is a compile error.
 */
export type LoadedMessages<Namespaces extends DeferredNamespace = never> = CoreMessages &
  Pick<Messages, Namespaces>;

/**
 * Locale available in the project.
 */
export type Locale = 'pt-BR' | 'en';
