/**
 * The English `git` keys that are not in the entry chunk. Import this from a
 * component that lives in the Git panel's chunk and pass it to `useI18n`:
 * `useI18n(gitMessages)`. Keep it out of anything the first paint reaches, or
 * the strings ride in the entry again (`tests/unit/i18n-feature-namespaces.test.ts`).
 */
export { messages as gitMessages } from '@mangostudio/shared/i18n/en-git';
