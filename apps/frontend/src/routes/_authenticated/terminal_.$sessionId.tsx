import { createFileRoute } from '@tanstack/react-router';

// No loader: the contract has no `GET /api/terminals/:id`, and the socket
// itself needs only the id in the URL — the popped-out window may not even
// know which environment this session lives on.
export const Route = createFileRoute('/_authenticated/terminal_/$sessionId')({});
