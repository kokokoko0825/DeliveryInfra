import type { ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import type { Feature } from '@delivery/shared';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FullScreenMessage, LoadingView } from '@/components/app/StatusView';
import { useAuth } from './auth-context';
import { resolveGuard } from './guard';

type Props = { feature?: Feature; requireDisplayName?: boolean; children?: ReactNode };

export function RequireAuth({ feature, requireDisplayName, children }: Props) {
  const { status, me, error } = useAuth();
  const location = useLocation();
  const result = resolveGuard({ status, me, feature, requireDisplayName });
  switch (result.kind) {
    case 'loading':
      return <LoadingView />;
    case 'error':
      return <FullScreenMessage title="読み込みに失敗しました" description={error ?? '時間をおいて再読み込みしてください。'} />;
    case 'redirect':
      return <Navigate to={result.to} replace state={{ from: location.pathname }} />;
    case 'forbidden':
      return (
        <section className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center" aria-labelledby="forbidden-title">
          <ShieldAlert className="size-10 text-muted-foreground" aria-hidden />
          <h1 id="forbidden-title" className="text-xl font-semibold">このページを表示する権限がありません</h1>
          <p className="text-sm text-muted-foreground">ご利用のロールでは開けないページです。必要な場合は管理者に連絡してください。</p>
          <Button asChild><Link to={result.home}>ホームへ戻る</Link></Button>
        </section>
      );
    default:
      return children ?? <Outlet />;
  }
}
