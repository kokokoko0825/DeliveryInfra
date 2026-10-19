/** Stage 戦略と参加者属性の解釈（SDK 非依存の純粋ロジック）。 */

/** SDK の SubscribeType と同じ文字列値。 */
export const SUBSCRIBE = { NONE: 'none', AUDIO_ONLY: 'audio_only', AUDIO_VIDEO: 'audio_video' } as const;
export type SubscribeValue = (typeof SUBSCRIBE)[keyof typeof SUBSCRIBE];

/** SDK の StageConnectionState と同じ文字列値。 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'errored';

export type ParticipantKind = 'camera' | 'mic' | 'slide' | 'switcher' | 'unknown';
export type RemoteParticipant = { id: string; kind: ParticipantKind; deviceName: string };

const KINDS: readonly ParticipantKind[] = ['camera', 'mic', 'slide', 'switcher'];

/** トークン属性 `{kind, deviceName}` から参加者を識別する。 */
export function toRemoteParticipant(info: { id: string; attributes?: Record<string, unknown> }): RemoteParticipant {
  const attributes = info.attributes ?? {};
  const rawKind = attributes.kind;
  const kind = typeof rawKind === 'string' && (KINDS as readonly string[]).includes(rawKind) ? (rawKind as ParticipantKind) : 'unknown';
  const rawName = attributes.deviceName;
  const deviceName = typeof rawName === 'string' && rawName.length > 0 ? rawName : info.id.slice(0, 8);
  return { id: info.id, kind, deviceName };
}

/** 受信する参加者の種別: カメラ・スライドは映像+音声、マイクは音声のみ、それ以外は受信しない。 */
export function subscribeTypeFor(participant: RemoteParticipant, subscribe: boolean): SubscribeValue {
  if (!subscribe) return SUBSCRIBE.NONE;
  if (participant.kind === 'camera' || participant.kind === 'slide') return SUBSCRIBE.AUDIO_VIDEO;
  if (participant.kind === 'mic') return SUBSCRIBE.AUDIO_ONLY;
  return SUBSCRIBE.NONE;
}

/** 送信は publish 権限があり、送るトラックが1本以上あるときだけ。 */
export function shouldPublish(publish: boolean, trackCount: number): boolean {
  return publish && trackCount > 0;
}

/** 切断理由が自動再接続の対象か（明示的な退出・強制切断・ステージ削除は対象外）。 */
export function isRecoverableLeave(reason: string): boolean {
  return !['user-initiated', 'participant-disconnected', 'stage-deleted'].includes(reason);
}
