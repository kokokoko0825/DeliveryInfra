import { useEffect, useRef, type ReactNode } from 'react';
import type { StagePurpose } from '@delivery/shared';
import { ArrowRightLeft, CircleAlert, Radio } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { errorText, statusText, type SenderErrorKind, type SenderStatus } from './engine/session';

/** 接続状態。送信中だけアクセント色、エラーは destructive、それ以外は控えめな文字色。 */
export function ConnectionStatus({ status, label }: { status: SenderStatus; label?: string | undefined }) {
  return (
    <p role="status" aria-live="polite" className={cn('inline-flex items-center gap-2 text-sm font-medium',
      status === 'live' ? 'text-primary' : status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
      <Radio aria-hidden className={cn('size-4', status === 'reconnecting' && 'motion-safe:animate-pulse')} />
      {label ?? statusText(status)}
    </p>
  );
}

export function LevelMeter({ label, value, muted = false }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{muted ? 'ミュート中' : `${value}`}</span>
      </div>
      <Progress aria-label={label} value={muted ? 0 : value} className={cn(muted && 'opacity-40')} />
    </div>
  );
}

export function DeviceNameSelect({ id, options, value, onChange, disabled }: { id: string; options: string[]; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>端末名</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="h-11 w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

export function VideoPreview({ stream, label }: { stream: MediaStream | null; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
      <video ref={ref} aria-label={label} className="size-full object-contain" autoPlay muted playsInline />
      {!stream && <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">プレビューなし</p>}
    </div>
  );
}

export function ErrorNotice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertDescription>
        {children}
        {action}
      </AlertDescription>
    </Alert>
  );
}

/** 送信エラーの表示。本人の別端末が同じ端末名を使っているときは「この端末に切り替える」を出す（R3-02）。 */
export function SenderErrorNotice({ error, purpose, deviceName, onTakeover }: { error: SenderErrorKind; purpose: StagePurpose; deviceName?: string | undefined; onTakeover: () => void }) {
  return (
    <ErrorNotice action={error === 'nameInUseSelf' && (
      <Button variant="outline" className="mt-2 h-11" onClick={onTakeover}><ArrowRightLeft aria-hidden />この端末に切り替える</Button>
    )}>
      {errorText(error, purpose, deviceName)}
    </ErrorNotice>
  );
}

export function SenderShell({ title, description, status, children }: { title: string; description: string; status: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle><h1 className="text-xl font-semibold">{title}</h1></CardTitle>
          <CardDescription>{description}</CardDescription>
          <div className="pt-1">{status}</div>
        </CardHeader>
        <CardContent className="space-y-6">{children}</CardContent>
      </Card>
    </main>
  );
}
