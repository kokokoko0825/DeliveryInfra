import { z } from 'zod';

export const ROLES = ['admin', 'camera', 'audio', 'presenter', 'viewer'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;
export const StagePurposeSchema = z.enum(['viewer', 'camera', 'mic', 'slide', 'switcher']);
export type StagePurpose = z.infer<typeof StagePurposeSchema>;
export const ROLE_PURPOSES: Record<Role, readonly StagePurpose[]> = {
  admin: ['viewer', 'camera', 'mic', 'slide', 'switcher'], camera: ['viewer', 'camera'],
  audio: ['viewer', 'mic'], presenter: ['viewer', 'slide'], viewer: ['viewer'],
};
export const STAGE_LIMITS = { camera: 6, mic: 5, slide: 1 } as const;
export const canRequestPurpose = (role: Role, purpose: StagePurpose): boolean => ROLE_PURPOSES[role].includes(purpose);

export const FEATURES = ['watch', 'archives', 'cameraSend', 'micSend', 'venueSpeaker', 'slideShare', 'switcher', 'broadcastManage', 'slideManage', 'commentModeration', 'userManage'] as const;
export type Feature = typeof FEATURES[number];
const permissions: Record<Feature, readonly Role[]> = {
  watch: ROLES, archives: ROLES, cameraSend: ['admin', 'camera'], micSend: ['admin', 'audio'], venueSpeaker: ['admin', 'audio'],
  slideShare: ['admin', 'presenter'], switcher: ['admin'], broadcastManage: ['admin'],
  slideManage: ['admin'], commentModeration: ['admin'], userManage: ['admin'],
};
export const canAccess = (role: Role, feature: Feature): boolean => permissions[feature].includes(role);

export const ROLE_REDIRECTS: Record<Role, string> = { admin: '/watch', camera: '/send/camera', audio: '/send/mic', presenter: '/send/slide', viewer: '/watch' };
export const getPostLoginPath = (role: Role): string => ROLE_REDIRECTS[role];
