import { authClient } from '@/lib/auth-client';

/**
 * The name the app greets somebody by: the first word of their display name.
 *
 * Empty string for an account with no display name and for a session that has
 * not resolved yet, which every caller reads as "greet me without a name"
 * rather than rendering a gap where one should be. Shared by the chat hub and
 * the dashboard so the two cannot disagree about what to call the same person.
 *
 * // Usage: const userName = useUserFirstName(); // => 'Julio'
 */
export function useUserFirstName(): string {
  const { data: session } = authClient.useSession();
  return session?.user?.name?.split(' ')[0] ?? '';
}
