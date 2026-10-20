import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { getPostLoginPath } from '@delivery/shared';
import { Building2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { AuthShell } from '@/components/app/AuthShell';
import { ErrorText, LoadingView } from '@/components/app/StatusView';
import { authErrorMessage, loginWithEmail, loginWithOkta } from '@/lib/auth';
import { EmailSchema } from '@/lib/validation';
import { useAuth } from './auth-context';

const LoginSchema = z.object({ email: EmailSchema, password: z.string().min(1, 'パスワードを入力してください') });
type LoginValues = z.infer<typeof LoginSchema>;

export default function LoginPage() {
  const { status, me, config, refresh, loginError } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<LoginValues>({ resolver: zodResolver(LoginSchema), defaultValues: { email: '', password: '' } });

  if (status === 'loading') return <LoadingView />;
  if (status === 'signedIn' && me) return <Navigate to={me.displayName ? getPostLoginPath(me.role) : '/display-name'} replace />;

  const onSubmit = async ({ email, password }: LoginValues) => {
    setError(null);
    try {
      const result = await loginWithEmail(email, password);
      if (result === 'NEW_PASSWORD_REQUIRED') { navigate('/password', { state: { mode: 'new', email } }); return; }
      if (result === 'RESET_PASSWORD') { navigate('/password', { state: { mode: 'reset', email } }); return; }
      const profile = await refresh();
      if (profile) navigate('/display-name', { replace: true });
      else setError('ユーザー情報を取得できませんでした。時間をおいて再度お試しください');
    } catch (cause) {
      setError(authErrorMessage(cause));
    }
  };

  const okta = config?.oauth;
  // 画面上の操作のエラーを優先し、無ければ Okta から戻ってきたときの失敗理由を出す
  const shownError = error ?? loginError;
  const registered = (location.state as { registered?: boolean } | null)?.registered === true;
  return (
    <AuthShell title="ログイン" description="アカウントにログインしてください。">
      <div className="space-y-6">
        <Button
          className="min-h-11 w-full"
          disabled={!okta}
          onClick={() => { if (okta) loginWithOkta(okta.oktaProviderName).catch((cause: unknown) => setError(authErrorMessage(cause))); }}
        >
          <Building2 aria-hidden />Oktaでログイン
        </Button>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Separator className="flex-1" />または<Separator className="flex-1" />
        </div>
        <Form {...form}>
          <form className="space-y-4" noValidate onSubmit={form.handleSubmit(onSubmit)}>
            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem>
                <FormLabel>メールアドレス</FormLabel>
                <FormControl><Input type="email" autoComplete="username" inputMode="email" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="password" render={({ field }) => (
              <FormItem>
                <FormLabel>パスワード</FormLabel>
                <FormControl><Input type="password" autoComplete="current-password" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {shownError && <ErrorText message={shownError} />}
            <Button type="submit" variant="outline" className="min-h-11 w-full" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}
              メールアドレスでログイン
            </Button>
          </form>
        </Form>
        {registered && <p role="status" className="text-center text-sm">メールアドレスを確認しました。ログインしてください。</p>}
        <p className="text-center text-sm">
          <Link className="inline-flex min-h-11 items-center underline-offset-4 hover:underline" to="/password" state={{ mode: 'reset' }}>
            パスワードを忘れた場合
          </Link>
        </p>
        <p className="text-center text-sm">アカウントをお持ちでない方は <Link className="underline-offset-4 hover:underline" to="/signup">ユーザー登録</Link></p>
      </div>
    </AuthShell>
  );
}
