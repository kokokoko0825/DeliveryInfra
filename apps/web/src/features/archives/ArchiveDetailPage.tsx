import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/PageHeader';
import { ErrorText, LoadingView } from '@/components/app/StatusView';
import { errorMessage } from '@/lib/api';
import { useFileCookies } from '@/lib/files';
import { formatDuration } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { fetchArchives } from './api';
import { HlsPlayer } from './HlsPlayer';

/** U-04 アーカイブ再生。playbackPath は API が返すパスをそのまま使う。 */
export default function ArchiveDetailPage() {
  const { id } = useParams();
  const archives = useQuery({ queryKey: queryKeys.archives, queryFn: fetchArchives });
  const cookies = useFileCookies();
  const archive = archives.data?.find((item) => item.id === id);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" className="min-h-11 -ml-3"><Link to="/archives"><ArrowLeft aria-hidden />アーカイブ一覧</Link></Button>
      {(archives.isPending || cookies.isPending) && <LoadingView />}
      {archives.error && <ErrorText message={errorMessage(archives.error)} />}
      {cookies.error && <ErrorText message={`再生の準備に失敗しました: ${errorMessage(cookies.error)}`} />}
      {archives.data && !archive && <p className="py-12 text-center text-muted-foreground">アーカイブが見つかりません</p>}
      {archive && (
        <>
          <PageHeader title={archive.title} description={`再生時間 ${formatDuration(archive.durationSeconds)}`} />
          {cookies.data && <HlsPlayer src={archive.playbackPath} title={archive.title} />}
        </>
      )}
    </div>
  );
}
