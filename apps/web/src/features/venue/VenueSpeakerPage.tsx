import { useEffect, useRef, useState } from 'react';
import { MonitorPlay, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SenderShell } from '@/features/sender/components';
import { startVenueSpeaker, type VenueSession } from './venueAudio';
import { holdWakeLock } from '@/lib/ivs/wakeLock';

export default function VenueSpeakerPage() {
  const [status, setStatus] = useState('停止');
  const [rtt, setRtt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<VenueSession | null>(null);
  useEffect(() => () => session.current?.close(), []);
  useEffect(
    () =>
      status === '停止' || status === 'エラー' ? undefined : holdWakeLock(),
    [status],
  );
  const start = async () => {
    try {
      setError(null);
      setStatus('マイク端末を待っています');
      const current = await startVenueSpeaker(setRtt);
      session.current = current;
      setStatus('接続中');
      await current.connected;
      setStatus('接続中');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '接続に失敗しました');
      setStatus('エラー');
    }
  };
  const stop = () => {
    session.current?.close();
    session.current = null;
    setStatus('停止');
    setRtt(null);
  };
  return (
    <SenderShell
      title="会場音声 PoC: スピーカー"
      description="DataChannel の PCM 音声を AudioWorklet で再生します。"
      status={<span>{status}</span>}
    >
      <p role="status" className="text-sm">
        状態: {status}
      </p>
      <p className="text-sm">
        計測 RTT: {rtt === null ? '未計測' : `${rtt.toFixed(1)} ms`}
        （ネットワーク往復時間）
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status === '停止' || status === 'エラー' ? (
        <Button className="h-11 w-full" onClick={() => void start()}>
          <MonitorPlay aria-hidden />
          受信開始
        </Button>
      ) : (
        <Button variant="outline" className="h-11 w-full" onClick={stop}>
          <Square aria-hidden />
          停止
        </Button>
      )}
      <p className="text-sm text-muted-foreground">
        ブラウザの自動再生制限を解除するため、このボタンを押して開始してください。RTT
        は片道音声遅延ではありません。
      </p>
    </SenderShell>
  );
}
