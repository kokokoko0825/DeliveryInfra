import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/lib/api';
import { fetchStatus } from '@/lib/ivs/mediaApi';
import { cn } from '@/lib/utils';
import { preflightItems, preflightReady } from '../engine/broadcast';

export const STATUS_QUERY_KEY = ['status'] as const;

/** 配信前チェック（F-OPS-02）: ステージ3つと Chat ルームが使えるか。 */
export function PreflightPanel() {
  const status = useQuery({ queryKey: STATUS_QUERY_KEY, queryFn: fetchStatus });
  const items = status.data ? preflightItems(status.data) : [];
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center justify-between text-base">
          配信前チェック
          <Button variant="ghost" size="icon" className="size-11" aria-label="再確認" onClick={() => void status.refetch()} disabled={status.isFetching}>
            <RefreshCw aria-hidden className={cn(status.isFetching && 'motion-safe:animate-spin')} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        {status.isError && <p role="alert" className="text-sm text-destructive">{errorMessage(status.error)}</p>}
        {status.isPending && <p className="text-sm text-muted-foreground">確認しています…</p>}
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2">
                {item.ok ? <CircleCheck aria-hidden className="size-4 text-muted-foreground" /> : <CircleX aria-hidden className="size-4 text-destructive" />}
                {item.label}
              </span>
              <span className={cn('text-xs', item.ok ? 'text-muted-foreground' : 'text-destructive')}>{item.detail}</span>
            </li>
          ))}
        </ul>
        {status.data && <p className="text-sm font-medium">{preflightReady(items) ? '配信の準備ができています' : '問題があります。インフラの状態を確認してください'}</p>}
      </CardContent>
    </Card>
  );
}
