'use client';

import { use } from 'react';
import { MediaCarouselBuilderPage } from '@/components/settings/media-carousel-builder-page';

interface EditCarouselPageProps {
  params: Promise<{ id: string }>;
}

export default function EditCarouselTemplatePage({ params }: EditCarouselPageProps) {
  const resolvedParams = use(params);
  return <MediaCarouselBuilderPage initialTemplateId={resolvedParams.id} />;
}
