/** Authenticated user info returned by session. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string;
}

/** Active session info. */
export interface AuthSession {
  user: AuthUser;
  token: string;
  expiresAt: number;
}
