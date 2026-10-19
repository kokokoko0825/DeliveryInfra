import { EmptyResponseSchema } from '@delivery/shared';
import { apiFetch } from './api';

/** 管理者のコメント削除（サーバーが IVS Chat の DeleteMessage と削除フラグを行う）。 */
export const deleteComment = (messageId: string) =>
  apiFetch(`/comments/${encodeURIComponent(messageId)}`, { method: 'DELETE', schema: EmptyResponseSchema });

/** 管理者によるユーザーのコメント送信停止・解除。 */
export const setCommentSuspension = (userId: string, suspended: boolean) =>
  apiFetch(`/users/${encodeURIComponent(userId)}/comment-suspension`, { method: 'PUT', body: { suspended }, schema: EmptyResponseSchema });
