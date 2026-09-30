import { createFileRoute } from '@tanstack/react-router';
import { settleShellQuery } from '@/features/bootstrap/shell-bootstrap';
import { chatListQueryOptions } from '@/features/chat/queries';

export const Route = createFileRoute('/_authenticated/home')({
  // The one thing this page cannot render without: every card below reads the
  // chat list, directly or through the folders grouped out of it. The parent
  // layout already settles it, so this is a cache hit that keeps the promise
  // explicit rather than a second request. Everything else mounts client-side
  // and degrades on its own, which is why none of it is loaded here.
  //
  // Settled rather than ensured: this route has no error boundary of its own,
  // so a throw here would reach the layout's and take the shell down with a
  // chat list the layout is already showing as failed in its place.
  loader: async ({ context: { queryClient } }) => {
    await settleShellQuery(queryClient, chatListQueryOptions());
  },
});
