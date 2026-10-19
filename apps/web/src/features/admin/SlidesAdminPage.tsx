import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SLIDE_TITLE_MAX, TitleSchema, type Slide } from '@delivery/shared';
import { ArrowDown, ArrowUp, Loader2, Pencil, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmAction } from '@/components/app/ConfirmAction';
import { PageHeader } from '@/components/app/PageHeader';
import { ErrorText, LoadingView } from '@/components/app/StatusView';
import { TitleEditDialog } from '@/components/app/TitleEditDialog';
import { fetchSlides } from '@/features/slides/api';
import { errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { moveItem } from '@/lib/list';
import { queryKeys } from '@/lib/query-keys';
import { validateSlideFile } from '@/lib/validation';
import { deleteSlide, renameSlide, reorderSlides, uploadSlide } from './slides-api';

function UploadForm() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: ({ t, f }: { t: string; f: File }) => uploadSlide(t, f),
    onSuccess: async () => {
      toast.success('スライドを公開しました');
      setTitle('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await queryClient.invalidateQueries({ queryKey: queryKeys.slides });
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const onFileChange = (selected: File | null) => {
    setFile(selected);
    setError(selected ? validateSlideFile(selected) : null);
    if (selected && !title) setTitle(selected.name.replace(/\.pdf$/i, '').slice(0, SLIDE_TITLE_MAX));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsedTitle = TitleSchema.safeParse(title);
    if (!parsedTitle.success) { setError(`タイトルは1〜${SLIDE_TITLE_MAX}文字で入力してください`); return; }
    if (!file) { setError('PDF ファイルを選択してください'); return; }
    const invalid = validateSlideFile(file);
    if (invalid) { setError(invalid); return; }
    setError(null);
    upload.mutate({ t: parsedTitle.data, f: file });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle><h2>PDF をアップロード</h2></CardTitle>
        <CardDescription>PDF（application/pdf）1ファイル 50MB まで。アップロード後すぐ視聴者の一覧に表示されます。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={onSubmit} noValidate>
          <div className="space-y-2">
            <Label htmlFor="slide-file">ファイル</Label>
            <Input id="slide-file" ref={fileRef} type="file" accept=".pdf,application/pdf"
              onChange={(event) => onFileChange(event.target.files?.[0] ?? null)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="slide-title">タイトル</Label>
            <Input id="slide-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <Button type="submit" className="min-h-11" disabled={upload.isPending}>
            {upload.isPending ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Upload aria-hidden />}
            アップロード
          </Button>
        </form>
        {file && !error && <p className="mt-2 text-sm text-muted-foreground">{file.name}（{formatBytes(file.size)}）</p>}
        {error && <div className="mt-2"><ErrorText message={error} /></div>}
      </CardContent>
    </Card>
  );
}

function SlideRow({ slide, index, total, onMove }: { slide: Slide; index: number; total: number; onMove: (index: number, delta: number) => void }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.slides });
  const remove = useMutation({
    mutationFn: () => deleteSlide(slide.id),
    onSuccess: () => { toast.success('スライドを削除しました'); return refresh(); },
    onError: (cause) => { toast.error(errorMessage(cause)); },
  });
  return (
    <li className="flex flex-wrap items-center gap-2 py-3">
      <span className="w-6 text-center text-sm text-muted-foreground">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium break-all">{slide.title}</p>
        <p className="text-sm text-muted-foreground">{slide.fileName}・{formatBytes(slide.size)}</p>
      </div>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon" className="size-11" aria-label={`${slide.title} を上へ移動`} disabled={index === 0} onClick={() => onMove(index, -1)}><ArrowUp aria-hidden /></Button>
        <Button variant="ghost" size="icon" className="size-11" aria-label={`${slide.title} を下へ移動`} disabled={index === total - 1} onClick={() => onMove(index, 1)}><ArrowDown aria-hidden /></Button>
        <TitleEditDialog heading="スライドのタイトルを変更" initialTitle={slide.title}
          onSave={async (title) => {
            try { await renameSlide(slide.id, title); await refresh(); } catch (cause) { toast.error(errorMessage(cause)); throw cause; }
          }}
          trigger={<Button variant="ghost" size="icon" className="size-11" aria-label={`${slide.title} のタイトルを変更`}><Pencil aria-hidden /></Button>} />
        <ConfirmAction
          trigger={<Button variant="ghost" size="icon" className="size-11" aria-label={`${slide.title} を削除`}><Trash2 aria-hidden /></Button>}
          title="スライドを削除しますか？" description={`「${slide.title}」を削除します。視聴者の一覧からも即時に消えます。`}
          confirmLabel="削除" onConfirm={() => remove.mutate()} />
      </div>
    </li>
  );
}

/** A-02 スライド管理。並べ替えはキーボードで操作できる上下ボタン。 */
export default function SlidesAdminPage() {
  const queryClient = useQueryClient();
  const slides = useQuery({ queryKey: queryKeys.slides, queryFn: fetchSlides });
  const reorder = useMutation({
    mutationFn: (next: readonly Slide[]) => reorderSlides(next.map((slide) => slide.id)),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.slides });
      const previous = queryClient.getQueryData<Slide[]>(queryKeys.slides);
      queryClient.setQueryData(queryKeys.slides, next.map((slide, order) => ({ ...slide, order })));
      return { previous };
    },
    onError: (cause, _next, context) => {
      queryClient.setQueryData(queryKeys.slides, context?.previous);
      toast.error(errorMessage(cause));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.slides }),
  });
  const onMove = (index: number, delta: number) => {
    if (!slides.data) return;
    const next = moveItem(slides.data, index, delta);
    if (next !== slides.data) reorder.mutate(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="スライド管理" description="PDF 資料の追加・タイトル変更・並べ替え・削除を行います。" />
      <UploadForm />
      <Card>
        <CardHeader><CardTitle><h2>公開中のスライド</h2></CardTitle></CardHeader>
        <CardContent>
          {slides.isPending && <LoadingView />}
          {slides.error && <ErrorText message={errorMessage(slides.error)} />}
          {slides.data?.length === 0 && <p className="py-6 text-center text-muted-foreground">スライドはまだありません</p>}
          {slides.data && slides.data.length > 0 && (
            <ol className="divide-y" aria-label="スライドの表示順">
              {slides.data.map((slide, index) => (
                <SlideRow key={slide.id} slide={slide} index={index} total={slides.data.length} onMove={onMove} />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
