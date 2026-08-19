/**
 * ChatGPT OAuth constants.
 *
 * The client id, redirect URI, and loopback port are fixed by OpenAI's public
 * client registration for subscription (ChatGPT plan) access — they are not
 * configurable. Only the base URLs can be overridden, via the `[chatgpt]`
 * config section, so tests can point the flow at a fake auth server.
 */

/** Public OAuth client id registered by OpenAI for subscription access. */
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Loopback port fixed by OpenAI's client registration. */
export const CHATGPT_OAUTH_CALLBACK_PORT = 1455;

export const CHATGPT_OAUTH_CALLBACK_PATH = '/auth/callback';

/**
 * Redirect URI for a loopback server listening on `port`. The authorize request
 * and the token exchange must carry the same one, and OpenAI accepts only the
 * registered port — so in production this is always `CHATGPT_OAUTH_REDIRECT_URI`.
 * // Usage: chatGptRedirectUri(loopback.port)
 */
export function chatGptRedirectUri(port: number): string {
  return `http://localhost:${port}${CHATGPT_OAUTH_CALLBACK_PATH}`;
}

/** Redirect URI registered for the client — must match exactly, including scheme and port. */
export const CHATGPT_OAUTH_REDIRECT_URI = chatGptRedirectUri(CHATGPT_OAUTH_CALLBACK_PORT);

export const CHATGPT_OAUTH_SCOPES = 'openid profile email offline_access';

/** JWT claim namespace that carries the ChatGPT account id and plan type. */
export const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth';
