/**
 * Most chat ids one `git/state/batch` request may carry. Callers batch the rows
 * they can see, not the whole chat history.
 *
 * Lives apart from `schemas.ts` so the browser can take the number without the
 * TypeBox builders for every git request and response.
 */
export const GIT_BATCH_STATE_MAX_CHAT_IDS = 50;
