import { createFileRoute } from '@tanstack/react-router';
import { GalleryPage } from '@/features/gallery/GalleryPage';

export const Route = createFileRoute('/_authenticated/gallery')({
  component: GalleryPage,
});
