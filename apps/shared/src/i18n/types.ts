type DeepStringRecord<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringRecord<T[K]>;
};

/**
 * Tipo Messages derivado do dicionário pt-BR (source of truth).
 * Verifica que todas as chaves existem, mas aceita qualquer valor string.
 * Todos os locales devem satisfazer este tipo.
 */
export type Messages = DeepStringRecord<typeof import('./pt-BR').messages>;

/**
 * Locale disponível no projeto.
 */
export type Locale = 'pt-BR' | 'en';
