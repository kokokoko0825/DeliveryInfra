import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { COMMENT_MAX, type Comment } from '@delivery/shared';
import { Ban, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ConfirmAction } from '@/components/app/ConfirmAction';
import { useAuth } from '@/features/auth/auth-context';
import { errorMessage } from '@/lib/api';
import { deleteComment, setCommentSuspension } from '@/lib/comments';
import { formatTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { checkComment } from '@/lib/validation';
import { useChat } from './chat-context';
import { BLOCK_MESSAGES, sendBlockReason } from './send-block';

/** 管理者向けモデレーション操作。スイッチング画面(A-01)のパネルでも同じものを渡す。 */
export type CommentModeration = {
  onDelete: (comment: Comment) => Promise<void> | void;
  onSuspend: (comment: Comment) => Promise<void> | void;
};

/** 管理者用のモデレーション操作（削除・コメント停止）を返す。 */
export function useAdminModeration(): CommentModeration {
  const { remove } = useChat();
  const queryClient = useQueryClient();
  return {
    onDelete: async (comment) => {
      try {
        await deleteComment(comment.messageId);
        remove(comment.messageId);
        toast.success('コメントを削除しました');
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    onSuspend: async (comment) => {
      try {
        await setCommentSuspension(comment.userId, true);
        void queryClient.invalidateQueries({ queryKey: queryKeys.users });
        toast.success(`${comment.displayName} さんのコメント送信を停止しました`);
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
  };
}


function CommentItem({ comment, moderation }: { comment: Comment; moderation?: CommentModeration | undefined }) {
  return (
    <li className="group flex items-start gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{comment.displayName}</span>
          <time className="ml-2" dateTime={comment.sentAt}>{formatTime(comment.sentAt)}</time>
        </p>
        <p className="text-sm break-words whitespace-pre-wrap">{comment.comment}</p>
      </div>
      {moderation && (
        <div className="flex shrink-0 gap-1">
          <ConfirmAction
            trigger={<Button variant="ghost" size="icon" className="size-11" aria-label={`${comment.displayName} さんのコメントを削除`}><Trash2 aria-hidden /></Button>}
            title="コメントを削除しますか？" description="全員の画面から即時に消えます。この操作は取り消せません。"
            confirmLabel="削除" onConfirm={() => { void moderation.onDelete(comment); }}
          />
          <ConfirmAction
            trigger={<Button variant="ghost" size="icon" className="size-11" aria-label={`${comment.displayName} さんのコメント送信を停止`}><Ban aria-hidden /></Button>}
            title="コメント送信を停止しますか？" description={`${comment.displayName} さんはコメントを送信できなくなります（視聴は継続できます）。解除はコメント管理画面から行えます。`}
            confirmLabel="停止" onConfirm={() => { void moderation.onSuspend(comment); }}
          />
        </div>
      )}
    </li>
  );
}

type Props = { moderation?: CommentModeration; className?: string };

/** コメントの閲覧・送信パネル（U-01）。moderation を渡すと管理者操作が表示される。 */
export function CommentPanel({ moderation, className }: Props) {
  const { me } = useAuth();
  const { comments, connection, capabilities, send } = useChat();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const lastSentAt = useRef<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const block = sendBlockReason(me?.commentSuspended ?? false, connection, capabilities);
  const length = text.trim().length;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }, [comments]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (block || sending) return;
    const now = Date.now();
    const result = checkComment(text, lastSentAt.current, now);
    if (!result.ok) { setError(result.message); return; }
    setError(null);
    setSending(true);
    try {
      await send(result.content);
      lastSentAt.current = now;
      setText('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className={cn('flex min-h-0 flex-col gap-0 py-0', className)}>
      <CardHeader className="border-b py-3"><CardTitle className="text-base"><h2>コメント</h2></CardTitle></CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col px-0">
        <ol ref={listRef} role="log" aria-live="polite" aria-label="コメント一覧" className="min-h-48 flex-1 divide-y overflow-y-auto px-4">
          {comments.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">まだコメントはありません</li>}
          {comments.map((comment) => <CommentItem key={comment.messageId} comment={comment} moderation={moderation} />)}
        </ol>
        <form className="space-y-2 border-t p-3" onSubmit={(event) => { void onSubmit(event); }} noValidate>
          {block ? (
            <p className="text-sm text-muted-foreground" role="status">{BLOCK_MESSAGES[block]}</p>
          ) : (
            <p className={cn('text-xs', length > COMMENT_MAX ? 'text-destructive' : 'text-muted-foreground')} aria-live="polite">
              {length} / {COMMENT_MAX} 文字・3秒に1回まで
            </p>
          )}
          <div className="flex gap-2">
            <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="コメントを入力" aria-label="コメント"
              aria-invalid={error !== null} disabled={block !== null} />
            <Button type="submit" size="icon" className="size-11 shrink-0" aria-label="送信" disabled={block !== null || sending}>
              <Send aria-hidden />
            </Button>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
