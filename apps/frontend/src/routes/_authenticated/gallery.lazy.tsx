import { createLazyFileRoute } from '@tanstack/react-router';
import { GalleryPage } from '@/features/gallery/GalleryPage';

export const Route = createLazyFileRoute('/_authenticated/gallery')({
  component: GalleryPage,
});
