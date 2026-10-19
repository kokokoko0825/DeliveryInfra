import type { Role } from '@delivery/shared';

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理者', camera: 'カメラ担当', audio: '音声担当', presenter: '登壇者', viewer: '視聴者',
};
