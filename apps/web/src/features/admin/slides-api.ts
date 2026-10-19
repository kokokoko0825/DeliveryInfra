import {
  EmptyResponseSchema, SlideCompleteResponseSchema, SlideUploadSchema, SlideUploadUrlResponseSchema, SlideSchema,
} from '@delivery/shared';
import { apiFetch } from '@/lib/api';
import { validateSlideFile } from '@/lib/validation';

/** A-02 アップロード: クライアント検証 → presigned POST → complete（サーバーが %PDF- を検証して公開）。 */
export async function uploadSlide(title: string, file: File) {
  const invalid = validateSlideFile(file);
  if (invalid) throw new Error(invalid);
  const request = SlideUploadSchema.parse({ title, fileName: file.name, size: file.size, contentType: 'application/pdf' });
  const { slideId, url, fields } = await apiFetch('/slides/upload-url', { method: 'POST', body: request, schema: SlideUploadUrlResponseSchema });
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  form.append('file', file);
  const uploaded = await fetch(url, { method: 'POST', body: form });
  if (!uploaded.ok) throw new Error('ファイルのアップロードに失敗しました');
  return apiFetch(`/slides/${encodeURIComponent(slideId)}/complete`, { method: 'POST', schema: SlideCompleteResponseSchema });
}

export const renameSlide = (id: string, title: string) =>
  apiFetch(`/slides/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title }, schema: SlideSchema });
export const reorderSlides = (ids: string[]) => apiFetch('/slides/order', { method: 'PUT', body: { ids }, schema: EmptyResponseSchema });
export const deleteSlide = (id: string) => apiFetch(`/slides/${encodeURIComponent(id)}`, { method: 'DELETE', schema: EmptyResponseSchema });
