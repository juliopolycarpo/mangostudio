import { createLazyFileRoute } from '@tanstack/react-router';
import { LocationSettings } from '@/features/library/components/LocationSettings';

export const Route = createLazyFileRoute('/_authenticated/environments/library/locations')({
  component: LocationSettings,
});
