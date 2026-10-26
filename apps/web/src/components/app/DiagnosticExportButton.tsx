import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadClientDiagnostics, listClientDiagnostics } from '@/lib/diagnostics';

export function DiagnosticExportButton() {
  const [count, setCount] = useState(() => listClientDiagnostics().length);
  const [exportFailed, setExportFailed] = useState(false);
  useEffect(() => {
    const update = () => setCount(listClientDiagnostics().length);
    window.addEventListener('clientdiagnostic', update);
    return () => window.removeEventListener('clientdiagnostic', update);
  }, []);
  const exportDiagnostics = () => {
    try {
      downloadClientDiagnostics();
      setExportFailed(false);
    } catch {
      setExportFailed(true);
    }
  };
  return <div className="space-y-1">
    <Button variant="outline" className="min-h-11 justify-start" onClick={exportDiagnostics}>
      <Download aria-hidden />診断ログを保存{count > 0 ? ` (${count})` : ''}
    </Button>
    {exportFailed && <p role="alert" className="text-sm text-destructive">診断ログを保存できませんでした。</p>}
  </div>;
}
