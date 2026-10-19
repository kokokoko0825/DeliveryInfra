import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Archive } from '@delivery/shared';
import { Pencil, PlayCircle, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ConfirmAction } from '@/components/app/ConfirmAction';
import { PageHeader } from '@/components/app/PageHeader';
import { ErrorText, LoadingView } from '@/components/app/StatusView';
import { TitleEditDialog } from '@/components/app/TitleEditDialog';
import { useAuth } from '@/features/auth/auth-context';
import { errorMessage } from '@/lib/api';
import { formatDate, formatDuration } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { deleteArchive, fetchArchives, updateArchive } from './api';
import { RetainUntilDialog } from './RetainUntilDialog';

/** アーカイブ管理（タイトル変更・公開/非公開・保存期限の延長・削除）。U-04 内の管理者向け操作。 */
function ArchiveAdminActions({ archive }: { archive: Archive }) {
  const queryClient = useQueryClient();
  const onDone = () => queryClient.invalidateQueries({ queryKey: queryKeys.archives });
  const onError = (cause: unknown) => { toast.error(errorMessage(cause)); };
  const update = useMutation({ mutationFn: (body: { title?: string; published?: boolean; retainUntil?: string }) => updateArchive(archive.id, body), onSuccess: onDone, onError });
  const remove = useMutation({ mutationFn: () => deleteArchive(archive.id), onSuccess: () => { toast.success('アーカイブを削除しました'); return onDone(); }, onError });
  const switchId = `publish-${archive.id}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-h-11 items-center gap-2 pr-2">
        <Switch id={switchId} checked={archive.published} disabled={update.isPending}
          onCheckedChange={(published) => update.mutate({ published })} />
        <Label htmlFor={switchId}>公開</Label>
      </div>
      <TitleEditDialog heading="アーカイブのタイトルを変更" initialTitle={archive.title}
        onSave={async (title) => { await update.mutateAsync({ title }); }}
        trigger={<Button variant="ghost" size="icon" className="size-11" aria-label={`${archive.title} のタイトルを変更`}><Pencil aria-hidden /></Button>} />
      <RetainUntilDialog title={archive.title} retainUntil={archive.retainUntil}
        onSave={async (retainUntil) => { await update.mutateAsync({ retainUntil }); toast.success('保存期限を延長しました'); }} />
      <ConfirmAction
        trigger={<Button variant="ghost" size="icon" className="size-11" aria-label={`${archive.title} を削除`}><Trash2 aria-hidden /></Button>}
        title="アーカイブを削除しますか？" description={`「${archive.title}」の録画データを削除します。この操作は取り消せません。`}
        confirmLabel="削除" onConfirm={() => remove.mutate()} />
    </div>
  );
}

/** U-04 アーカイブ一覧。視聴者等は公開分のみ、管理者は全件（API 側で制御）。 */
export default function ArchivesPage() {
  const { me } = useAuth();
  const archives = useQuery({ queryKey: queryKeys.archives, queryFn: fetchArchives });
  const isAdmin = me?.role === 'admin';
  return (
    <div className="space-y-6">
      <PageHeader title="アーカイブ" description="過去の配信の録画を視聴できます。" />
      {archives.isPending && <LoadingView />}
      {archives.error && <ErrorText message={errorMessage(archives.error)} />}
      {archives.data?.length === 0 && <p className="py-12 text-center text-muted-foreground">視聴できるアーカイブはまだありません</p>}
      {archives.data && archives.data.length > 0 && (
        <ul className="grid gap-3" aria-label="アーカイブ一覧">
          {archives.data.map((archive) => (
            <li key={archive.id}>
              <Card className="gap-3 py-4">
                <CardHeader className="px-4">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <span className="break-all">{archive.title}</span>
                    {isAdmin && <Badge variant={archive.published ? 'secondary' : 'outline'}>{archive.published ? '公開中' : '非公開'}</Badge>}
                  </CardTitle>
                  <CardDescription>
                    再生時間 {formatDuration(archive.durationSeconds)}
                    {isAdmin && <span className="ml-3">保存期限 {formatDate(archive.retainUntil)}</span>}
                  </CardDescription>
                  <CardAction>
                    <Button asChild variant="outline" className="min-h-11">
                      <Link to={`/archives/${encodeURIComponent(archive.id)}`}><PlayCircle aria-hidden />再生</Link>
                    </Button>
                  </CardAction>
                </CardHeader>
                {isAdmin && <div className="px-4"><ArchiveAdminActions archive={archive} /></div>}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
