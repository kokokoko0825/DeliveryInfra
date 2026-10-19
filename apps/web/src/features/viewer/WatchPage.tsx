import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BroadcastResponseSchema, ViewerCountResponseSchema } from '@delivery/shared';
import { Clock, SlidersHorizontal, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/features/auth/auth-context';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useViewerStage } from '@/lib/viewer-stage';
import { CommentPanel, useAdminModeration } from './CommentPanel';
import { VideoPlayer } from './VideoPlayer';

export const fetchBroadcast = () => apiFetch('/broadcast', { schema: BroadcastResponseSchema });
const fetchStats = () => apiFetch('/broadcast/stats', { schema: ViewerCountResponseSchema });

function WaitingScreen({ ended }: { ended: boolean }) {
  return (
    <Card className="aspect-video items-center justify-center text-center">
      <CardContent className="flex flex-col items-center gap-3">
        <Clock className="size-10 text-muted-foreground" aria-hidden />
        <p className="text-lg font-semibold">{ended ? '配信は終了しました' : '配信開始までお待ちください'}</p>
        <p className="text-sm text-muted-foreground">
          {ended ? '録画はアーカイブとして公開されるまでお待ちください。' : '開始すると自動で映像が表示されます。'}
        </p>
        {ended && <Button asChild variant="outline" className="min-h-11"><Link to="/archives">アーカイブを見る</Link></Button>}
      </CardContent>
    </Card>
  );
}

function AdminTools({ live }: { live: boolean }) {
  const stats = useQuery({ queryKey: queryKeys.broadcastStats, queryFn: fetchStats, enabled: live, refetchInterval: 15_000 });
  return (
    <div className="flex flex-wrap items-center gap-3">
      {live && (
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <Users className="size-4" aria-hidden />同時視聴者数 {stats.data?.viewerCount ?? '—'} 人
        </span>
      )}
      <Button asChild variant="outline" className="min-h-11">
        <Link to="/admin/switcher"><SlidersHorizontal aria-hidden />スイッチング画面へ</Link>
      </Button>
    </div>
  );
}

function AdminCommentPanel() {
  return <CommentPanel className="h-[32rem] lg:h-full" moderation={useAdminModeration()} />;
}

export default function WatchPage() {
  const { me } = useAuth();
  const broadcast = useQuery({ queryKey: queryKeys.broadcast, queryFn: fetchBroadcast, refetchInterval: 60_000 });
  const live = broadcast.data?.status === 'live';
  const { stream, state } = useViewerStage(live);
  const isAdmin = me?.role === 'admin';

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="space-y-4" aria-labelledby="watch-title">
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="watch-title" className="text-2xl font-semibold tracking-tight">{broadcast.data?.title ?? '配信視聴'}</h1>
          {live && state === 'connected' && <Badge className="px-2 py-1">LIVE</Badge>}
          {live && state !== 'connected' && <Badge variant="secondary" role="status">{state === 'reconnecting' ? '再接続中…' : '接続中…'}</Badge>}
        </div>
        {isAdmin && <AdminTools live={live} />}
        {live ? <VideoPlayer stream={stream} /> : <WaitingScreen ended={broadcast.data?.status === 'ended'} />}
      </section>
      {isAdmin ? <AdminCommentPanel /> : <CommentPanel className="h-[32rem] lg:h-full" />}
    </div>
  );
}
