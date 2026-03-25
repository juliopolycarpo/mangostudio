import { createFileRoute } from '@tanstack/react-router';
import { GalleryPage } from '@/components/GalleryPage';

export const Route = createFileRoute('/_authenticated/gallery')({
  component: GalleryPage,
});