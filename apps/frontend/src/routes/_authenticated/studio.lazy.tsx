import { createLazyFileRoute } from '@tanstack/react-router';
import { StudioPage } from '@/features/studio/StudioPage';

export const Route = createLazyFileRoute('/_authenticated/studio')({
  component: StudioPage,
});
