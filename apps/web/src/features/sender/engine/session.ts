/** 送信セッションの状態機械と、エラーの分類・表示文言（DOM/IVS 非依存）。 */
import { STAGE_LIMITS, type StagePurpose } from '@delivery/shared';

export type SenderStatus = 'idle' | 'starting' | 'live' | 'reconnecting' | 'error';
export type SenderErrorKind = 'deviceLimit' | 'permission' | 'notFound' | 'busy' | 'forbidden' | 'network';
export type SenderState = { status: SenderStatus; error: SenderErrorKind | null; reconnects: number };

export type SenderEvent =
  | { type: 'START' }
  | { type: 'CONNECTED' }
  | { type: 'CONNECTION_LOST' }
  | { type: 'FAILED'; error: SenderErrorKind }
  | { type: 'STOPPED' };

export const initialSenderState: SenderState = { status: 'idle', error: null, reconnects: 0 };

export function senderReducer(state: SenderState, event: SenderEvent): SenderState {
  switch (event.type) {
    case 'START':
      if (state.status === 'starting' || state.status === 'live' || state.status === 'reconnecting') return state;
      return { status: 'starting', error: null, reconnects: 0 };
    case 'CONNECTED':
      if (state.status !== 'starting' && state.status !== 'reconnecting') return state;
      return { ...state, status: 'live', error: null };
    case 'CONNECTION_LOST':
      if (state.status !== 'live') return state;
      return { ...state, status: 'reconnecting', reconnects: state.reconnects + 1 };
    case 'FAILED':
      if (state.status === 'idle') return state;
      return { ...state, status: 'error', error: event.error };
    case 'STOPPED':
      return initialSenderState;
  }
}

/** 送信中（ウェイクロック・ハートビートを維持すべき状態）か。 */
export const isActive = (status: SenderStatus) => status === 'live' || status === 'reconnecting';
/** 開始ボタンを押せる状態か。 */
export const canStart = (status: SenderStatus) => status === 'idle' || status === 'error';

/** 例外を分類する。ApiError は code/status、メディア取得失敗は DOMException の name で判定する。 */
export function classifyError(error: unknown): SenderErrorKind {
  if (typeof error === 'object' && error !== null) {
    const { code, status, name } = error as { code?: unknown; status?: unknown; name?: unknown };
    if (code === 'DEVICE_LIMIT') return 'deviceLimit';
    if (status === 401 || status === 403) return 'forbidden';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'notFound';
    if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  }
  return 'network';
}

const KIND_LABEL: Partial<Record<StagePurpose, string>> = { camera: 'カメラ', mic: 'マイク', slide: 'スライド共有' };
const LIMIT: Partial<Record<StagePurpose, number>> = STAGE_LIMITS;

export function errorText(error: SenderErrorKind, purpose: StagePurpose): string {
  const label = KIND_LABEL[purpose] ?? '送信';
  switch (error) {
    case 'deviceLimit':
      return `${label}は最大${LIMIT[purpose] ?? 0}台まで接続できます。他の端末の送信が停止するまでお待ちください。`;
    case 'permission':
      return `${label}の使用が許可されていません。ブラウザの設定で許可してから、もう一度お試しください。`;
    case 'notFound':
      return `使用できる${label}が見つかりません。`;
    case 'busy':
      return `${label}を開始できませんでした。他のアプリが使用中でないか確認してください。`;
    case 'forbidden':
      return '送信する権限がありません。管理者にロールを確認してください。';
    case 'network':
      return '接続できませんでした。回線を確認して、もう一度お試しください。';
  }
}

export function statusText(status: SenderStatus): string {
  switch (status) {
    case 'idle': return '未接続';
    case 'starting': return '接続中';
    case 'live': return '送信中';
    case 'reconnecting': return '再接続中';
    case 'error': return 'エラー';
  }
}
