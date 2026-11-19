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
    | 'names'
    | 'lts'
    | 'status'
    | 'versionUnknown'
    | 'agents'
    | 'install'
    | 'findings'
    | 'pathSources'
    | 'runtimes'
    | 'actions';
  git: 'title' | 'refresh' | 'remote' | 'diff';
  github: 'title' | 'actions' | 'panel' | 'chip';
}

/**
 * A namespace key that is split one level down: only the sub-keys listed here
 * stay eager, the rest of that key ships with the feature's lazy chunk. Use it
 * for a key the first paint reads a little of and a lazy page reads most of
 * (`environments.entities`, `environments.machine`). A key listed here must not
 * also be in `EagerFeatureKeys`, which would keep all of it eager.
 */
interface EagerNestedFeatureKeys {
  environments: {
    entities:
      | 'status'
      | 'transport'
      | 'disabled'
      | 'toolchainSummaryNode'
      | 'toolchainSummaryBun'
      | 'toolchainSummaryMissing';
    machine: 'service' | 'actions' | 'update';
  };
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

/** The keys of a namespace that are split one level down (none for a namespace without nested keys). */
type SplitKeysOf<Namespace extends FeatureNamespace> =
  Namespace extends keyof EagerNestedFeatureKeys
    ? Extract<keyof EagerNestedFeatureKeys[Namespace], keyof Messages[Namespace]>
    : never;

/** The eager sub-keys of one split key. */
type EagerSubKeysOf<
  Namespace extends FeatureNamespace,
  Key extends SplitKeysOf<Namespace>,
> = Namespace extends keyof EagerNestedFeatureKeys
  ? Key extends keyof EagerNestedFeatureKeys[Namespace]
    ? Extract<EagerNestedFeatureKeys[Namespace][Key], keyof Messages[Namespace][Key]>
    : never
  : never;

/** The English keys of a feature namespace that are not in the eager dictionary. */
export type FeatureMessages<Namespace extends FeatureNamespace> = {
  [N in Namespace]: Omit<Messages[N], EagerKeysOf<N> | SplitKeysOf<N>> & {
    [K in SplitKeysOf<N>]: Omit<Messages[N][K], EagerSubKeysOf<N, K>>;
  };
};

/** What the eager dictionary holds: every namespace that is not deferred, and the eager keys of the split ones. */
export type CoreMessages = Omit<Messages, DeferredNamespace | FeatureNamespace> & {
  [N in FeatureNamespace]: Pick<Messages[N], EagerKeysOf<N>> & {
    [K in SplitKeysOf<N>]: Pick<Messages[N][K], EagerSubKeysOf<N, K>>;
  };
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
