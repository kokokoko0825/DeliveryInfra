import { useEffect, useId, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock, Gauge, Play, Square, Users } from 'lucide-react';
import { TitleSchema } from '@delivery/shared';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmAction } from '@/components/app/ConfirmAction';
import { errorMessage } from '@/lib/api';
import { fetchBroadcast, fetchBroadcastStats, startBroadcast, stopBroadcast } from '@/lib/ivs/mediaApi';
import { formatBitrate } from '@/lib/ivs/stats';
import { queryKeys } from '@/lib/query-keys';
import { formatElapsed } from '../engine/broadcast';

export const STATS_INTERVAL_MS = 10_000;

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

type Props = {
  running: boolean;
  publishing: boolean;
  bitrate: number | null;
  startPublishing: (options?: { resume?: boolean }) => Promise<void>;
  stopPublishing: () => void;
};

/** 配信開始・終了（確認ダイアログ付き F-SW-09）と、経過時間・同時視聴者数・送信ビットレート（F-SW-10）。 */
export function BroadcastPanel({ running, publishing, bitrate, startPublishing, stopPublishing }: Props) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const broadcast = useQuery({ queryKey: queryKeys.broadcast, queryFn: fetchBroadcast });
  const live = broadcast.data?.status === 'live';
  const stats = useQuery({ queryKey: queryKeys.broadcastStats, queryFn: fetchBroadcastStats, enabled: live, refetchInterval: STATS_INTERVAL_MS });
  const now = useNow(live);
  const titleCheck = TitleSchema.safeParse(title);

  // 配信中に画面を開き直した場合は番組の送信を再開する。失敗しても送信は止めず、自動で再試行させる（R3-04）
  useEffect(() => {
    if (running && live && !publishing && !busy) {
      startPublishing({ resume: true }).catch((error: unknown) => toast.error(`番組の送信を再開できませんでした。自動で再試行します（${errorMessage(error)}）`));
    }
  }, [busy, live, publishing, running, startPublishing]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.broadcast });
  const start = async () => {
    if (!titleCheck.success) return;
    setBusy(true);
    let started = false;
    try {
      // 先に配信用ステージへ送り始めてから、録画（コンポジション）を開始する
      await startPublishing();
      const broadcast = await startBroadcast(titleCheck.data);
      started = true;
      queryClient.setQueryData(queryKeys.broadcast, broadcast);
      toast.success('配信を開始しました');
      setTitle('');
    } catch (error) {
      // 開始の応答が成功した後は、番組の送信を止めない（R4-01）
      if (!started) stopPublishing();
      toast.error(errorMessage(error));
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      // 状態を先に ended にしてから送信を止める（送信の自動再開を起こさない）
      queryClient.setQueryData(queryKeys.broadcast, await stopBroadcast());
      stopPublishing();
      toast.success('配信を終了しました');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center justify-between text-base">
          配信
          <span role="status">{live ? <Badge>LIVE</Badge> : <Badge variant="outline" className="text-muted-foreground">配信していません</Badge>}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <dl className="grid grid-cols-3 gap-3">
          <Stat icon={<Clock aria-hidden className="size-3.5" />} label="経過時間" value={live ? formatElapsed(broadcast.data?.startedAt ?? null, now) : '—'} />
          <Stat icon={<Users aria-hidden className="size-3.5" />} label="同時視聴者" value={live && stats.data ? `${stats.data.viewerCount}人` : '—'} />
          <Stat icon={<Gauge aria-hidden className="size-3.5" />} label="送信" value={publishing ? formatBitrate(bitrate) : '—'} />
        </dl>
        {live ? (
          <ConfirmAction
            trigger={<Button variant="outline" className="h-11 w-full" disabled={busy}><Square aria-hidden />配信終了</Button>}
            title="配信を終了しますか？" description="視聴者への配信と録画が止まります。この操作は取り消せません。" confirmLabel="配信終了"
            onConfirm={() => void stop()} />
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor={titleId}>配信タイトル</Label>
              <Input id={titleId} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} className="h-11" placeholder="例: 10月定例会" />
              {title.length > 0 && !titleCheck.success && <p role="alert" className="text-sm text-destructive">タイトルは1〜100文字で入力してください</p>}
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button className="h-11 w-full" disabled={!running || busy || !titleCheck.success}><Play aria-hidden />配信開始</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>配信を開始しますか？</AlertDialogTitle>
                  <AlertDialogDescription>「{title.trim()}」を視聴者に配信し、録画を開始します。プログラムの映像がそのまま配信されます。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="min-h-11">キャンセル</AlertDialogCancel>
                  <AlertDialogAction className="min-h-11" onClick={() => void start()}>配信開始</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {!running && <p className="text-sm text-muted-foreground">スイッチャーを起動すると配信を開始できます。</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
