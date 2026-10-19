import { SlidesResponseSchema } from '@delivery/shared';
import { apiFetch } from '@/lib/api';

export const fetchSlides = () => apiFetch('/slides', { schema: SlidesResponseSchema });
