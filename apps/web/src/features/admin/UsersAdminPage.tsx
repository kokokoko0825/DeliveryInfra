import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ROLES, type INVITE_FAILURE_REASONS, type Role, type UserInviteResponse } from '@delivery/shared';
import { CircleAlert, Loader2, Send, Trash2, UserPlus } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmAction } from '@/components/app/ConfirmAction';
import { PageHeader } from '@/components/app/PageHeader';
import { ErrorText, LoadingView } from '@/components/app/StatusView';
import { ROLE_LABELS } from '@/components/app/roles';
import { useAuth } from '@/features/auth/auth-context';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { parseEmailCsv, parseEmailList } from '@/lib/validation';
import { changeRole, deleteUser, fetchUsers, inviteUsers, resendInvite, setUserEnabled } from './users-api';

function RoleSelect({ id, value, onChange, disabled, label }: { id?: string; value: Role | null; onChange: (role: Role) => void; disabled?: boolean; label?: string }) {
  return (
    // 空文字で未選択（プレースホルダー表示）にする。ロール要修復のユーザーで使う（R2-04）
    <Select value={value ?? ''} onValueChange={(next) => onChange(next as Role)} disabled={disabled}>
      <SelectTrigger id={id} className="h-11 w-36" aria-label={label}><SelectValue placeholder="ロールを選択" /></SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => <SelectItem key={role} value={role} className="min-h-11">{ROLE_LABELS[role]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

const INVITE_FAILURE_LABELS: Record<(typeof INVITE_FAILURE_REASONS)[number], string> = {
  ALREADY_EXISTS: 'すでに登録されています',
  INVALID_PARAMETER: 'メールアドレスが受け付けられませんでした',
  FAILED: '送信に失敗しました',
  CREATED_WITHOUT_ROLE: 'アカウントは作成されましたがロールを付与できませんでした。一覧でロールを設定してください',
};

function InviteFailures({ failed }: { failed: UserInviteResponse['failed'] }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertTitle>{failed.length} 件は招待できませんでした</AlertTitle>
      <AlertDescription>
        <ul aria-label="招待できなかったアドレス" className="list-inside list-disc">
          {failed.map((failure) => <li key={failure.email} className="break-all">{failure.email}：{INVITE_FAILURE_LABELS[failure.reason]}</li>)}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function InviteForm() {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<UserInviteResponse['failed']>([]);
  const parsed = parseEmailList(text);
  const invite = useMutation({
    mutationFn: () => inviteUsers(parsed.emails, role),
    onSuccess: (result) => {
      if (result.invited.length > 0) toast.success(`${result.invited.length} 件の招待メールを送信しました`);
      // 失敗分だけ入力欄に残し、直して再送できるようにする（R1-11）
      setFailed(result.failed);
      // CREATED_WITHOUT_ROLE は再招待すると「登録済み」になるため残さず、一覧のロール変更で直す（R2-02）
      setText(result.failed.filter((failure) => failure.reason !== 'CREATED_WITHOUT_ROLE').map((failure) => failure.email).join('\n'));
      return queryClient.invalidateQueries({ queryKey: queryKeys.users });
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const onCsv = async (file: File | undefined) => {
    if (!file) return;
    const { emails, invalid } = parseEmailCsv(await file.text());
    setText((current) => [current.trim(), ...emails, ...invalid].filter(Boolean).join('\n'));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed.invalid.length > 0) { setError(`形式が正しくないメールアドレスがあります: ${parsed.invalid.join(', ')}`); return; }
    if (parsed.emails.length === 0) { setError('メールアドレスを1件以上入力してください'); return; }
    setError(null);
    setFailed([]);
    invite.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle><h2>ユーザーを招待</h2></CardTitle>
        <CardDescription>仮パスワードを記載した招待メールが送信されます。複数のアドレスは改行・カンマで区切るか、CSV を読み込んでください。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <div className="space-y-2">
            <Label htmlFor="invite-emails">メールアドレス</Label>
            <Textarea id="invite-emails" rows={4} value={text} onChange={(event) => setText(event.target.value)} aria-invalid={parsed.invalid.length > 0} />
            <p className="text-sm text-muted-foreground" aria-live="polite">
              有効 {parsed.emails.length} 件{parsed.invalid.length > 0 && <span className="text-destructive">・形式エラー {parsed.invalid.length} 件</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="invite-csv">CSV から読み込む</Label>
              <Input id="invite-csv" type="file" accept=".csv,text/csv" onChange={(event) => { void onCsv(event.target.files?.[0]); event.target.value = ''; }} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">ロール</Label>
              <RoleSelect id="invite-role" value={role} onChange={setRole} />
            </div>
            <Button type="submit" className="min-h-11" disabled={invite.isPending}>
              {invite.isPending ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <UserPlus aria-hidden />}
              招待する
            </Button>
          </div>
          {error && <ErrorText message={error} />}
          {failed.length > 0 && <InviteFailures failed={failed} />}
        </form>
      </CardContent>
    </Card>
  );
}

function UsersTable() {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: queryKeys.users, queryFn: fetchUsers });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.users });
  const onError = (cause: unknown) => { toast.error(errorMessage(cause)); };
  const role = useMutation({ mutationFn: (v: { userId: string; role: Role }) => changeRole(v.userId, v.role), onSuccess: () => { toast.success('ロールを変更しました'); return refresh(); }, onError });
  const enabled = useMutation({ mutationFn: (v: { userId: string; enabled: boolean }) => setUserEnabled(v.userId, v.enabled), onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: deleteUser, onSuccess: () => { toast.success('ユーザーを削除しました'); return refresh(); }, onError });
  const resend = useMutation({ mutationFn: resendInvite, onSuccess: () => { toast.success('招待メールを再送しました'); }, onError });

  if (users.isPending) return <LoadingView />;
  if (users.error) return <ErrorText message={errorMessage(users.error)} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>メールアドレス</TableHead><TableHead>ログイン方式</TableHead><TableHead>ロール</TableHead>
          <TableHead>最終ログイン</TableHead><TableHead>状態</TableHead><TableHead><span className="sr-only">操作</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.data.map((user) => {
          const self = user.userId === me?.userId;
          return (
            <TableRow key={user.userId}>
              <TableCell className="break-all whitespace-normal">{user.email}{self && <span className="ml-1 text-muted-foreground">（自分）</span>}</TableCell>
              <TableCell>{user.loginMethod === 'Okta' ? 'Okta' : 'メール'}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <RoleSelect value={user.role} disabled={self || role.isPending} label={`${user.email} のロール`}
                    onChange={(next) => role.mutate({ userId: user.userId, role: next })} />
                  {user.role === null && <Badge variant="destructive"><CircleAlert aria-hidden />ロール要修復</Badge>}
                </div>
              </TableCell>
              <TableCell>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <Badge variant={user.enabled ? 'secondary' : 'outline'}>{user.enabled ? '有効' : '無効'}</Badge>
                  {user.invitePending && <Badge variant="outline">招待中</Badge>}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex gap-1">
                  {user.invitePending && (
                    <Button variant="outline" className="min-h-11" disabled={resend.isPending} onClick={() => resend.mutate(user.userId)}>
                      <Send aria-hidden />招待を再送
                    </Button>
                  )}
                  {user.enabled ? (
                    <ConfirmAction
                      trigger={<Button variant="outline" className="min-h-11" disabled={self}>無効化</Button>}
                      title="ユーザーを無効化しますか？" description={`${user.email} はログイン中のセッションも含めて利用できなくなります。`}
                      confirmLabel="無効化" onConfirm={() => enabled.mutate({ userId: user.userId, enabled: false })} />
                  ) : (
                    <Button variant="outline" className="min-h-11" onClick={() => enabled.mutate({ userId: user.userId, enabled: true })}>有効化</Button>
                  )}
                  <ConfirmAction
                    trigger={<Button variant="ghost" size="icon" className="size-11" disabled={self} aria-label={`${user.email} を削除`}><Trash2 aria-hidden /></Button>}
                    title="ユーザーを削除しますか？" description={`${user.email} を削除します。この操作は取り消せません。`}
                    confirmLabel="削除" onConfirm={() => remove.mutate(user.userId)} />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** A-05 ユーザー管理。 */
export default function UsersAdminPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="ユーザー管理" description="メールユーザーの招待・招待の再送、ロール変更、無効化・削除を行います。" />
      <InviteForm />
      <Card>
        <CardHeader><CardTitle><h2>ユーザー一覧</h2></CardTitle></CardHeader>
        <CardContent><UsersTable /></CardContent>
      </Card>
    </div>
  );
}
