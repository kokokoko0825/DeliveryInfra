import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/lib/format';
import { endOfJstDay, retainUntilFormSchema, toJstDate } from './retention';

/** アーカイブの保存期限の延長（Review-1 R1-22、plan 5.5）。期限を過ぎると録画は自動で削除される。 */
export function RetainUntilDialog({ title, retainUntil, onSave }: {
  title: string; retainUntil: string;
  /** 失敗時は例外を投げる（ダイアログを閉じない） */
  onSave: (retainUntil: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const schema = retainUntilFormSchema(retainUntil);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), values: { date: toJstDate(retainUntil) } });
  const onSubmit = async ({ date }: z.infer<typeof schema>) => {
    try {
      await onSave(endOfJstDay(date));
      setOpen(false);
    } catch {
      // 失敗の通知は onSave 側（トースト）で行い、ダイアログは開いたままにする
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11" aria-label={`${title} の保存期限を延長`}><CalendarClock aria-hidden /></Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>保存期限を延長</DialogTitle>
          <DialogDescription>現在の期限は {formatDate(retainUntil)} です。期限を過ぎると録画は自動で削除されます。</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" noValidate onSubmit={form.handleSubmit(onSubmit)}>
            <FormField control={form.control} name="date" render={({ field }) => (
              <FormItem>
                <FormLabel>新しい保存期限</FormLabel>
                <FormControl><Input type="date" min={toJstDate(retainUntil)} className="min-h-11" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="submit" className="min-h-11" disabled={form.formState.isSubmitting}>延長</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
