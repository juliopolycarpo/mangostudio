/**
 * The English `library` keys that are not in the entry chunk. Import this from a
 * component that lives in the Library route's chunk and pass it to `useI18n`:
 * `useI18n(libraryMessages)`. Keep it out of anything the first paint reaches, or
 * the strings ride in the entry again (`tests/unit/i18n-feature-namespaces.test.ts`).
 */
export { messages as libraryMessages } from '@mangostudio/shared/i18n/en-library';
