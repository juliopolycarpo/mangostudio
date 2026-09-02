import { createLazyFileRoute } from '@tanstack/react-router';
import { TerminalIndexPage } from '@/features/terminal/TerminalIndexPage';

export const Route = createLazyFileRoute('/_authenticated/terminal')({
  component: TerminalIndexPage,
});
