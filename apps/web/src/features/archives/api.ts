import { ArchiveUpdateResponseSchema, ArchivesResponseSchema, EmptyResponseSchema } from '@delivery/shared';
import { apiFetch } from '@/lib/api';

export const fetchArchives = () => apiFetch('/archives', { schema: ArchivesResponseSchema });
export const updateArchive = (id: string, body: { title?: string; published?: boolean }) =>
  apiFetch(`/archives/${encodeURIComponent(id)}`, { method: 'PATCH', body, schema: ArchiveUpdateResponseSchema });
export const deleteArchive = (id: string) =>
  apiFetch(`/archives/${encodeURIComponent(id)}`, { method: 'DELETE', schema: EmptyResponseSchema });
