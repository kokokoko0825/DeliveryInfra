/**
 * WebRTC 送受信の SDK はブラウザ専用で、読み込み時に window を参照する。
 * HTTP 契約の結合テストでは使わないため、apps/web が import する名前だけを持つスタブに差し替える。
 */
export class Stage { constructor() { throw new Error('IVS Stage はこのテストでは使えません'); } }
export class LocalStageStream {}
export const StageConnectionState = {};
export const StageEvents = {};
export const SubscribeType = { AUDIO_VIDEO: 'audio_video', AUDIO_ONLY: 'audio_only', NONE: 'none' } as const;
