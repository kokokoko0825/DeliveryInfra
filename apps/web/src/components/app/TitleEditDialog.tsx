import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { SLIDE_TITLE_MAX, TitleSchema } from '@delivery/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';

const Schema = z.object({ title: TitleSchema });

/** スライド・アーカイブのタイトル変更（1〜100文字）。 */
export function TitleEditDialog({ trigger, heading, initialTitle, onSave }: {
  trigger: ReactNode; heading: string; initialTitle: string;
  /** 失敗時は例外を投げる（ダイアログを閉じない） */
  onSave: (title: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const form = useForm<z.infer<typeof Schema>>({ resolver: zodResolver(Schema), values: { title: initialTitle } });
  const onSubmit = async ({ title }: z.infer<typeof Schema>) => {
    try {
      await onSave(title);
      setOpen(false);
    } catch {
      // 失敗の通知は onSave 側（トースト）で行い、ダイアログは開いたままにする
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{SLIDE_TITLE_MAX}文字以内で入力してください。</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" noValidate onSubmit={form.handleSubmit(onSubmit)}>
            <FormField control={form.control} name="title" render={({ field }) => (
              <FormItem>
                <FormLabel>タイトル</FormLabel>
                <FormControl><Input {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="submit" className="min-h-11" disabled={form.formState.isSubmitting}>保存</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
