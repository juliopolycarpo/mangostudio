import { createFileRoute } from '@tanstack/react-router';
import { chatListQueryOptions } from '@/features/chat/queries';

export const Route = createFileRoute('/_authenticated/home')({
  // The one thing this page cannot render without: every card below reads the
  // chat list, directly or through the folders grouped out of it. The parent
  // layout already ensures it, so this is a cache hit that keeps the promise
  // explicit rather than a second request. Everything else mounts client-side
  // and degrades on its own, which is why none of it is loaded here.
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(chatListQueryOptions()),
});
