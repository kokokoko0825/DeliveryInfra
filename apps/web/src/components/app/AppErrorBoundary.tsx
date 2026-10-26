import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { recordClientDiagnostic, downloadClientDiagnostics } from '@/lib/diagnostics';

type Props = { children: ReactNode };
type State = { failed: boolean; exportFailed: boolean };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, exportFailed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    recordClientDiagnostic(error, 'react.render', { componentStack: info.componentStack?.slice(0, 1_500) });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">画面を表示できませんでした</h1>
      <p role="alert" className="text-sm text-muted-foreground">診断ログを保存して共有するか、ページを再読み込みしてください。</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => {
          try { downloadClientDiagnostics(); this.setState({ exportFailed: false }); }
          catch { this.setState({ exportFailed: true }); }
        }}>診断ログを保存</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>再読み込み</Button>
      </div>
      {this.state.exportFailed && <p role="alert" className="text-sm text-destructive">診断ログを保存できませんでした。</p>}
    </main>;
  }
}
