export interface AuthContext {
  isAuthenticated: boolean;
  user: { id: string; name: string; email: string } | null;
  isPending: boolean;
}