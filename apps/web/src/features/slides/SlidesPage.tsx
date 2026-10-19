import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Slide } from '@delivery/shared';
import { Download, ExternalLink, Eye, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/app/PageHeader';
import { ErrorText, LoadingView } from '@/components/app/StatusView';
import { errorMessage } from '@/lib/api';
import { slideFileUrl, useFileCookies } from '@/lib/files';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { fetchSlides } from './api';

function SlideViewer({ slide, onClose }: { slide: Slide | null; onClose: () => void }) {
  return (
    <Dialog open={slide !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[90vh] max-w-[min(90vw,72rem)] flex-col sm:max-w-[min(90vw,72rem)]">
        <DialogHeader>
          <DialogTitle>{slide?.title}</DialogTitle>
          <DialogDescription>表示されない場合は「新しいタブで開く」をお試しください。</DialogDescription>
        </DialogHeader>
        {slide && <iframe className="min-h-0 w-full flex-1 rounded-md border" src={slideFileUrl(slide.id)} title={slide.title} />}
        {slide && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild variant="outline" className="min-h-11">
              <a href={slideFileUrl(slide.id)} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden />新しいタブで開く</a>
            </Button>
            <Button asChild className="min-h-11">
              <a href={slideFileUrl(slide.id)} download={slide.fileName}><Download aria-hidden />ダウンロード</a>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** U-02 スライド一覧。追加・削除は Chat の slides-updated で即時に再取得される。 */
export default function SlidesPage() {
  const slides = useQuery({ queryKey: queryKeys.slides, queryFn: fetchSlides });
  const cookies = useFileCookies();
  const [viewing, setViewing] = useState<Slide | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader title="スライド" description="資料を選んでブラウザで閲覧、またはダウンロードできます。" />
      {(slides.isPending || cookies.isPending) && <LoadingView />}
      {slides.error && <ErrorText message={errorMessage(slides.error)} />}
      {cookies.error && <ErrorText message={`資料の閲覧準備に失敗しました: ${errorMessage(cookies.error)}`} />}
      {slides.data && cookies.data && (
        slides.data.length === 0
          ? <p className="py-12 text-center text-muted-foreground">公開中のスライドはまだありません</p>
          : (
            <ul className="grid gap-3 sm:grid-cols-2" aria-label="スライド一覧">
              {slides.data.map((slide) => (
                <li key={slide.id}>
                  <Card className="gap-2 py-4">
                    <CardHeader className="px-4">
                      <CardTitle className="flex items-center gap-2 text-base"><FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="break-all">{slide.title}</span></CardTitle>
                      <CardDescription>{slide.fileName}・{formatBytes(slide.size)}</CardDescription>
                      <CardAction className="flex gap-1">
                        <Button variant="ghost" size="icon" className="size-11" aria-label={`${slide.title} を閲覧`} onClick={() => setViewing(slide)}><Eye aria-hidden /></Button>
                        <Button asChild variant="ghost" size="icon" className="size-11">
                          <a href={slideFileUrl(slide.id)} download={slide.fileName} aria-label={`${slide.title} をダウンロード`}><Download aria-hidden /></a>
                        </Button>
                      </CardAction>
                    </CardHeader>
                  </Card>
                </li>
              ))}
            </ul>
          )
      )}
      <SlideViewer slide={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
