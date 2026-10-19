import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useForm, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { AuthShell } from '@/components/app/AuthShell';
import { ErrorText } from '@/components/app/StatusView';
import { authErrorMessage, completeNewPassword, confirmPasswordReset, isAuthSessionExpired, requestPasswordReset } from '@/lib/auth';
import { useAuth } from './auth-context';
import { NewPasswordSchema, ResetConfirmSchema, ResetRequestSchema } from './password-schemas';

type PasswordState = { mode?: 'new' | 'reset'; email?: string } | null;
const POLICY = '12文字以上で、英大文字・英小文字・数字をそれぞれ含めてください。';

function TextField<T extends FieldValues>({ form, name, label, type = 'text', autoComplete, description }: {
  form: UseFormReturn<T>; name: Path<T>; label: string; type?: string; autoComplete?: string; description?: string;
}) {
  return (
    <FormField control={form.control} name={name} render={({ field }) => (
      <FormItem>
        <FormLabel>{label}</FormLabel>
        <FormControl><Input type={type} autoComplete={autoComplete} {...field} /></FormControl>
        {description && <FormDescription>{description}</FormDescription>}
        <FormMessage />
      </FormItem>
    )} />
  );
}

function SubmitButton({ pending, children }: { pending: boolean; children: string }) {
  return (
    <Button type="submit" className="min-h-11 w-full" disabled={pending}>
      {pending && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}{children}
    </Button>
  );
}

/** 初回ログイン時の仮パスワード変更（Cognito の NEW_PASSWORD_REQUIRED チャレンジ）。 */
function NewPasswordForm() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const form = useForm<z.infer<typeof NewPasswordSchema>>({ resolver: zodResolver(NewPasswordSchema), defaultValues: { newPassword: '', confirmPassword: '' } });
  const onSubmit = async ({ newPassword }: z.infer<typeof NewPasswordSchema>) => {
    setError(null);
    try {
      const result = await completeNewPassword(newPassword);
      if (result !== 'DONE') { setError('パスワードを設定できませんでした。最初からやり直してください'); return; }
      if (await refresh()) navigate('/display-name', { replace: true });
      else setError('ユーザー情報を取得できませんでした。再度ログインしてください');
    } catch (cause) {
      // 認証セッション切れは再入力しても通らないので、ログインからやり直す導線に切り替える（R4-04）
      setExpired(isAuthSessionExpired(cause));
      setError(authErrorMessage(cause));
    }
  };
  return (
    <Form {...form}>
      <form className="space-y-4" noValidate onSubmit={form.handleSubmit(onSubmit)}>
        <TextField form={form} name="newPassword" label="新しいパスワード" type="password" autoComplete="new-password" description={POLICY} />
        <TextField form={form} name="confirmPassword" label="新しいパスワード（確認）" type="password" autoComplete="new-password" />
        {error && <ErrorText message={error} />}
        {expired
          ? <Button asChild className="min-h-11 w-full"><Link to="/login" replace>ログインからやり直す</Link></Button>
          : <SubmitButton pending={form.formState.isSubmitting}>パスワードを設定</SubmitButton>}
      </form>
    </Form>
  );
}

/** パスワード再設定（メールの確認コード）。 */
function ResetPasswordForm({ initialEmail }: { initialEmail: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestForm = useForm<z.infer<typeof ResetRequestSchema>>({ resolver: zodResolver(ResetRequestSchema), defaultValues: { email: initialEmail } });
  const confirmForm = useForm<z.infer<typeof ResetConfirmSchema>>({ resolver: zodResolver(ResetConfirmSchema), defaultValues: { code: '', newPassword: '', confirmPassword: '' } });

  const onRequest = async (values: z.infer<typeof ResetRequestSchema>) => {
    setError(null);
    try {
      await requestPasswordReset(values.email);
      setEmail(values.email);
    } catch (cause) {
      setError(authErrorMessage(cause));
    }
  };
  const onConfirm = async ({ code, newPassword }: z.infer<typeof ResetConfirmSchema>) => {
    if (!email) return;
    setError(null);
    try {
      await confirmPasswordReset(email, code, newPassword);
      toast.success('パスワードを再設定しました。新しいパスワードでログインしてください');
      navigate('/login', { replace: true });
    } catch (cause) {
      setError(authErrorMessage(cause));
    }
  };

  if (!email) {
    return (
      <Form {...requestForm}>
        <form className="space-y-4" noValidate onSubmit={requestForm.handleSubmit(onRequest)}>
          <TextField form={requestForm} name="email" label="メールアドレス" type="email" autoComplete="username" />
          {error && <ErrorText message={error} />}
          <SubmitButton pending={requestForm.formState.isSubmitting}>確認コードを送信</SubmitButton>
        </form>
      </Form>
    );
  }
  return (
    <Form {...confirmForm}>
      <form className="space-y-4" noValidate onSubmit={confirmForm.handleSubmit(onConfirm)}>
        <p className="text-sm text-muted-foreground">{email} に確認コードを送信しました。</p>
        <TextField form={confirmForm} name="code" label="確認コード" autoComplete="one-time-code" />
        <TextField form={confirmForm} name="newPassword" label="新しいパスワード" type="password" autoComplete="new-password" description={POLICY} />
        <TextField form={confirmForm} name="confirmPassword" label="新しいパスワード（確認）" type="password" autoComplete="new-password" />
        {error && <ErrorText message={error} />}
        <SubmitButton pending={confirmForm.formState.isSubmitting}>パスワードを再設定</SubmitButton>
      </form>
    </Form>
  );
}

export default function PasswordPage() {
  const state = useLocation().state as PasswordState;
  const isNew = state?.mode === 'new';
  return (
    <AuthShell
      title={isNew ? '初回パスワード設定' : 'パスワード再設定'}
      description={isNew ? '招待メールの仮パスワードから、新しいパスワードに変更してください。' : '登録済みのメールアドレスに確認コードを送信します。'}
    >
      <div className="space-y-4">
        {isNew ? <NewPasswordForm /> : <ResetPasswordForm initialEmail={state?.email ?? ''} />}
        <p className="text-center text-sm">
          <Link className="inline-flex min-h-11 items-center underline-offset-4 hover:underline" to="/login">ログイン画面へ戻る</Link>
        </p>
      </div>
    </AuthShell>
  );
}
