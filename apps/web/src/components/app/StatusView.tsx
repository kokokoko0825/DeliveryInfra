import { Loader2 } from 'lucide-react';

export function LoadingView({ label = '読み込み中' }: { label?: string }) {
  return (
    <div role="status" className="flex min-h-[40vh] items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function FullScreenMessage({ title, description }: { title: string; description: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </main>
  );
}

export function ErrorText({ message }: { message: string }) {
  return <p role="alert" className="text-sm text-destructive">{message}</p>;
}
