/** WebRTC stats からの送信ビットレート計算（純粋関数）。 */
export type ByteSample = { bytes: number; timestampMs: number };

type StatLike = { type?: string; kind?: string; mediaType?: string; bytesSent?: number; timestamp?: number };

/** outbound-rtp の bytesSent を合計する。kind 指定時はその種別のみ。 */
export function sumOutboundBytes(report: Iterable<StatLike>, kind?: 'audio' | 'video'): ByteSample | null {
  let bytes = 0;
  let timestampMs = 0;
  let found = false;
  for (const stat of report) {
    if (stat.type !== 'outbound-rtp') continue;
    const statKind = stat.kind ?? stat.mediaType;
    if (kind && statKind !== kind) continue;
    found = true;
    bytes += stat.bytesSent ?? 0;
    timestampMs = Math.max(timestampMs, stat.timestamp ?? 0);
  }
  return found ? { bytes, timestampMs } : null;
}

/** 2サンプル間の kbps。時間が進んでいない・カウンタが巻き戻った場合は null。 */
export function bitrateKbps(prev: ByteSample | null, next: ByteSample | null): number | null {
  if (!prev || !next) return null;
  const elapsedMs = next.timestampMs - prev.timestampMs;
  const deltaBytes = next.bytes - prev.bytes;
  if (elapsedMs <= 0 || deltaBytes < 0) return null;
  return Math.round((deltaBytes * 8) / elapsedMs);
}

export function formatBitrate(kbps: number | null): string {
  if (kbps === null) return '—';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mbps`;
  return `${kbps} kbps`;
}
