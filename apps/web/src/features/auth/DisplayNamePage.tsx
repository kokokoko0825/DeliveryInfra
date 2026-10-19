import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { DISPLAY_NAME_MAX, DisplayNameRequestSchema, getPostLoginPath, type DisplayNameRequest } from '@delivery/shared';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { AuthShell } from '@/components/app/AuthShell';
import { ErrorText } from '@/components/app/StatusView';
import { apiFetch, errorMessage } from '@/lib/api';
import { useAuth } from './auth-context';

export const saveDisplayName = (body: DisplayNameRequest) => apiFetch('/me/display-name', { method: 'PUT', body });

export default function DisplayNamePage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<DisplayNameRequest>({
    resolver: zodResolver(DisplayNameRequestSchema),
    defaultValues: { displayName: me?.displayName ?? '' },
    mode: 'onChange',
  });
  const length = form.watch('displayName').trim().length;

  const onSubmit = async (values: DisplayNameRequest) => {
    setError(null);
    try {
      await saveDisplayName(values);
      const profile = await refresh();
      if (profile) navigate(getPostLoginPath(profile.role), { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <AuthShell title="表示名の設定" description="コメントに表示される名前です。前回の表示名を初期表示しています。">
      <Form {...form}>
        <form className="space-y-4" noValidate onSubmit={form.handleSubmit(onSubmit)}>
          <FormField control={form.control} name="displayName" render={({ field }) => (
            <FormItem>
              <FormLabel>表示名</FormLabel>
              <FormControl><Input autoComplete="nickname" {...field} /></FormControl>
              <FormDescription aria-live="polite">{length} / {DISPLAY_NAME_MAX} 文字（NGワードを含む名前は使えません）</FormDescription>
              <FormMessage />
            </FormItem>
          )} />
          {error && <ErrorText message={error} />}
          <Button type="submit" className="min-h-11 w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}
            決定
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
