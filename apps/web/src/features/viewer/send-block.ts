export type SendBlockReason = 'suspended' | 'connecting' | null;

/** コメント送信欄を無効にする理由。停止中ユーザー・未接続・SEND_MESSAGE 権限なし。 */
export function sendBlockReason(suspended: boolean, connection: string, capabilities: readonly string[]): SendBlockReason {
  if (suspended) return 'suspended';
  if (connection !== 'connected') return 'connecting';
  if (!capabilities.includes('SEND_MESSAGE')) return 'suspended';
  return null;
}

export const BLOCK_MESSAGES: Record<Exclude<SendBlockReason, null>, string> = {
  suspended: '管理者によりコメント送信が停止されています。視聴は引き続きご利用いただけます。',
  connecting: 'コメントサーバーに接続しています…',
};
