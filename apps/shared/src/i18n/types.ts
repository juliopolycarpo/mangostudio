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

/**
 * The keys of each feature namespace that stay in the eager English dictionary
 * because something outside the feature's lazy chunk reads them (the sidebar, the
 * command palette, the home widgets, the chat feed). Every other key of the
 * namespace lives in `en-<namespace>.ts`.
 */
interface EagerFeatureKeys {
  library:
    | 'targets'
    | 'kinds'
    | 'kindsInline'
    | 'matrix'
    | 'wizard'
    | 'locationSettings'
    | 'cellStateShort';
  environments:
    | 'nav'
    | 'tabs'
    | 'entities'
    | 'names'
    | 'lts'
    | 'status'
    | 'versionUnknown'
    | 'agents'
    | 'install'
    | 'findings'
    | 'pathSources'
    | 'runtimes'
    | 'machine'
    | 'actions';
  git: 'title' | 'refresh' | 'remote' | 'diff';
  github: 'title' | 'actions' | 'panel' | 'chip';
}

/**
 * Namespaces split in two: the keys in `EagerFeatureKeys` ride in the entry
 * chunk, the rest ship with the feature's lazy chunk, which imports its
 * `en-<namespace>.ts` and hands it to `useI18n`.
 */
export type FeatureNamespace = keyof EagerFeatureKeys;

/** The eager keys of a feature namespace that the dictionary has (a stale name in the list is ignored here; `en.ts` then fails on the key it still holds). */
type EagerKeysOf<Namespace extends FeatureNamespace> = Extract<
  EagerFeatureKeys[Namespace],
  keyof Messages[Namespace]
>;

/** The English keys of a feature namespace that are not in the eager dictionary. */
export type FeatureMessages<Namespace extends FeatureNamespace> = {
  [N in Namespace]: Omit<Messages[N], EagerKeysOf<N>>;
};

/** What the eager dictionary holds: every namespace that is not deferred, and the eager keys of the split ones. */
export type CoreMessages = Omit<Messages, DeferredNamespace | FeatureNamespace> & {
  [N in FeatureNamespace]: Pick<Messages[N], EagerKeysOf<N>>;
};

/**
 * The messages a component may read once `Namespaces` are available: the eager
 * dictionary plus the named deferred namespaces and feature namespaces. One that
 * is not named is absent from the type (a feature namespace shows only its eager
 * keys), so reading it is a compile error.
 */
export type LoadedMessages<Namespaces extends DeferredNamespace | FeatureNamespace = never> =
  CoreMessages & Pick<Messages, Namespaces>;

/**
 * Locale available in the project.
 */
export type Locale = 'pt-BR' | 'en';
