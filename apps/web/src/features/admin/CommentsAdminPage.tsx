import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { NgWordSchema } from '@delivery/shared';
import { Download, Plus, UserCheck, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/app/PageHeader';
import { ErrorText, LoadingView } from '@/components/app/StatusView';
import { CommentPanel, useAdminModeration } from '@/features/viewer/CommentPanel';
import { errorMessage } from '@/lib/api';
import { setCommentSuspension } from '@/lib/comments';
import { saveBlob } from '@/lib/download';
import { dateStamp } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { addNgWord, exportComments, fetchNgWords, removeNgWord } from './comments-api';
import { fetchUsers } from './users-api';

function SuspendedUsers() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: queryKeys.users, queryFn: fetchUsers });
  const resume = useMutation({
    mutationFn: (userId: string) => setCommentSuspension(userId, false),
    onSuccess: () => { toast.success('コメント送信の停止を解除しました'); return queryClient.invalidateQueries({ queryKey: queryKeys.users }); },
    onError: (cause) => { toast.error(errorMessage(cause)); },
  });
  const suspended = users.data?.filter((user) => user.commentSuspended) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle><h2>コメント停止中のユーザー</h2></CardTitle>
        <CardDescription>停止中も視聴は継続できます。</CardDescription>
      </CardHeader>
      <CardContent>
        {users.isPending && <LoadingView />}
        {users.error && <ErrorText message={errorMessage(users.error)} />}
        {users.data && suspended.length === 0 && <p className="text-sm text-muted-foreground">停止中のユーザーはいません</p>}
        <ul className="divide-y" aria-label="コメント停止中のユーザー">
          {suspended.map((user) => (
            <li key={user.userId} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 text-sm break-all">{user.email}</span>
              <Button variant="outline" className="min-h-11" disabled={resume.isPending} onClick={() => resume.mutate(user.userId)}>
                <UserCheck aria-hidden />解除
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function NgWords() {
  const queryClient = useQueryClient();
  const words = useQuery({ queryKey: queryKeys.ngWords, queryFn: fetchNgWords });
  const [word, setWord] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.ngWords });
  const add = useMutation({ mutationFn: addNgWord, onSuccess: () => { setWord(''); return refresh(); }, onError: (cause) => setError(errorMessage(cause)) });
  const remove = useMutation({ mutationFn: removeNgWord, onSuccess: refresh, onError: (cause) => { toast.error(errorMessage(cause)); } });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = NgWordSchema.safeParse(word);
    if (!parsed.success) { setError('NGワードは1〜100文字で入力してください'); return; }
    if (words.data?.includes(parsed.data)) { setError('すでに登録されています'); return; }
    setError(null);
    add.mutate(parsed.data);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle><h2>NGワード</h2></CardTitle>
        <CardDescription>含むコメント・表示名は送信時にブロックされます（全角半角・大小文字は区別しません）。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form className="flex items-end gap-2" onSubmit={onSubmit} noValidate>
          <div className="flex-1 space-y-2">
            <Label htmlFor="ng-word">追加する単語</Label>
            <Input id="ng-word" value={word} onChange={(event) => setWord(event.target.value)} aria-invalid={error !== null} />
          </div>
          <Button type="submit" variant="outline" className="min-h-11" disabled={add.isPending}><Plus aria-hidden />追加</Button>
        </form>
        {error && <ErrorText message={error} />}
        {words.isPending && <LoadingView />}
        {words.error && <ErrorText message={errorMessage(words.error)} />}
        <ul className="flex flex-wrap gap-2" aria-label="登録済みの NGワード">
          {words.data?.map((item) => (
            <li key={item}>
              <Badge variant="secondary" className="gap-0 py-0 pr-0 text-sm">
                {item}
                <Button variant="ghost" size="icon" className="size-11" aria-label={`${item} を削除`} onClick={() => remove.mutate(item)}><X aria-hidden /></Button>
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** A-04 コメント管理。コメント一覧は U-01 と同じパネルにモデレーション操作を差し込んで再利用する。 */
export default function CommentsAdminPage() {
  const moderation = useAdminModeration();
  const exporting = useMutation({
    mutationFn: exportComments,
    onSuccess: (blob) => saveBlob(blob, `comments-${dateStamp(new Date())}.csv`),
    onError: (cause) => { toast.error(errorMessage(cause)); },
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="コメント管理"
        description="コメントの削除、ユーザーのコメント停止・解除、NGワードの編集、ログの CSV 出力を行います。"
        actions={(
          <Button variant="outline" className="min-h-11" disabled={exporting.isPending} onClick={() => exporting.mutate()}>
            <Download aria-hidden />CSV を出力
          </Button>
        )}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <CommentPanel className="h-[36rem]" moderation={moderation} />
        <div className="space-y-6">
          <SuspendedUsers />
          <NgWords />
        </div>
      </div>
    </div>
  );
}
