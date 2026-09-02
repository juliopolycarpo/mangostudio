import { createLazyFileRoute } from '@tanstack/react-router';
import { TerminalSessionPage } from '@/features/terminal/TerminalSessionPage';

export const Route = createLazyFileRoute('/_authenticated/terminal_/$sessionId')({
  component: TerminalSessionRoute,
});

function TerminalSessionRoute() {
  const { sessionId } = Route.useParams();
  return <TerminalSessionPage sessionId={sessionId} />;
}
