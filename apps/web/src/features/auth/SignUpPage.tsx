import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { AuthShell } from '@/components/app/AuthShell';
import { ErrorText } from '@/components/app/StatusView';
import { authErrorMessage, confirmEmailRegistration, registerWithEmail } from '@/lib/auth';
import { EmailSchema } from '@/lib/validation';

const SignupSchema = z.object({ email: EmailSchema, password: z.string().min(12, 'パスワードは12文字以上で入力してください').regex(/[a-z]/, '小文字を含めてください').regex(/[A-Z]/, '大文字を含めてください').regex(/[0-9]/, '数字を含めてください') });
const CodeSchema = z.object({ code: z.string().trim().min(1, '確認コードを入力してください') });
type SignupValues = z.infer<typeof SignupSchema>;

export default function SignUpPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signupForm = useForm<SignupValues>({ resolver: zodResolver(SignupSchema), defaultValues: { email: '', password: '' } });
  const codeForm = useForm<z.infer<typeof CodeSchema>>({ resolver: zodResolver(CodeSchema), defaultValues: { code: '' } });

  const onRegister = async (values: SignupValues) => {
    setError(null);
    try {
      await registerWithEmail(values.email, values.password);
      setEmail(values.email);
      setConfirming(true);
    } catch (cause) { setError(authErrorMessage(cause)); }
  };
  const onConfirm = async ({ code }: z.infer<typeof CodeSchema>) => {
    setError(null);
    try {
      await confirmEmailRegistration(email, code);
      navigate('/login', { replace: true, state: { registered: true } });
    } catch (cause) { setError(authErrorMessage(cause)); }
  };

  return (
    <AuthShell title="ユーザー登録" description={confirming ? `${email} に届いた確認コードを入力してください。` : 'メールアドレスを確認すると、視聴者アカウントを作成できます。'}>
      {confirming ? (
        <Form {...codeForm}>
          <form className="space-y-4" noValidate onSubmit={codeForm.handleSubmit(onConfirm)}>
            <FormField control={codeForm.control} name="code" render={({ field }) => <FormItem><FormLabel>確認コード</FormLabel><FormControl><Input autoComplete="one-time-code" inputMode="numeric" {...field} /></FormControl><FormMessage /></FormItem>} />
            {error && <ErrorText message={error} />}
            <Button type="submit" className="min-h-11 w-full" disabled={codeForm.formState.isSubmitting}>{codeForm.formState.isSubmitting && <Loader2 className="animate-spin" aria-hidden />}メールアドレスを確認</Button>
          </form>
        </Form>
      ) : (
        <Form {...signupForm}>
          <form className="space-y-4" noValidate onSubmit={signupForm.handleSubmit(onRegister)}>
            <FormField control={signupForm.control} name="email" render={({ field }) => <FormItem><FormLabel>メールアドレス</FormLabel><FormControl><Input type="email" autoComplete="email" inputMode="email" {...field} /></FormControl><FormMessage /></FormItem>} />
            <FormField control={signupForm.control} name="password" render={({ field }) => <FormItem><FormLabel>パスワード</FormLabel><FormControl><Input type="password" autoComplete="new-password" {...field} /></FormControl><FormMessage /></FormItem>} />
            <p className="text-sm text-muted-foreground">12文字以上で、大文字・小文字・数字を含めてください。</p>
            {error && <ErrorText message={error} />}
            <Button type="submit" className="min-h-11 w-full" disabled={signupForm.formState.isSubmitting}>{signupForm.formState.isSubmitting && <Loader2 className="animate-spin" aria-hidden />}確認コードを送信</Button>
          </form>
        </Form>
      )}
      <p className="mt-6 text-center text-sm"><Link className="underline-offset-4 hover:underline" to="/login">ログイン画面へ戻る</Link></p>
    </AuthShell>
  );
}
