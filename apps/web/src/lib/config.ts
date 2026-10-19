import { z } from 'zod';

/** CloudFront から配信される /config.json の形式（環境ごとに CDK が生成する）。 */
export const RuntimeConfigSchema = z.object({
  region: z.string().min(1),
  userPoolId: z.string().min(1),
  userPoolClientId: z.string().min(1),
  oauth: z.object({
    domain: z.string().min(1),
    redirectSignIn: z.string().url(),
    redirectSignOut: z.string().url(),
    oktaProviderName: z.string().min(1),
  }).optional(),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

let cached: Promise<RuntimeConfig> | undefined;

export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  cached ??= fetch('/config.json', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('設定ファイルを読み込めませんでした');
      return RuntimeConfigSchema.parse(await response.json());
    })
    .catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
  return cached;
}

export const resetRuntimeConfigCache = () => { cached = undefined; };
