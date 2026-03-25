/**
 * Tipo Messages derivado do dicionário pt-BR (source of truth).
 * Todos os locales devem satisfazer este tipo.
 */
export type Messages = typeof import('./pt-BR').messages;

/**
 * Locale disponível no projeto.
 */
export type Locale = 'pt-BR' | 'en';
