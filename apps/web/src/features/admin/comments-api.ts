import { EmptyResponseSchema, NgWordsResponseSchema } from '@delivery/shared';
import { apiFetch } from '@/lib/api';

export const fetchNgWords = () => apiFetch('/ng-words', { schema: NgWordsResponseSchema });
export const addNgWord = (word: string) => apiFetch('/ng-words', { method: 'POST', body: { word } });
export const removeNgWord = (word: string) => apiFetch(`/ng-words/${encodeURIComponent(word)}`, { method: 'DELETE', schema: EmptyResponseSchema });
/** CSV は UTF-8 BOM 付き。BOM を保つため Blob のまま受け取る。 */
export const exportComments = () => apiFetch<Blob>('/comments/export', { responseType: 'blob' });
