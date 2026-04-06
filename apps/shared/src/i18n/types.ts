type DeepStringRecord<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringRecord<T[K]>;
};

/**
 * Messages type derived from the pt-BR dictionary (source of truth).
 * Verifies all keys exist but accepts any string value.
 * All locales must satisfy this type.
 */
export type Messages = DeepStringRecord<typeof import('./pt-BR').messages>;

/**
 * Locale available in the project.
 */
export type Locale = 'pt-BR' | 'en';
