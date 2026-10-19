import { existsSync } from 'node:fs';
import path from 'node:path';
import { App } from 'aws-cdk-lib';
import { INFRA_ROOT, buildApp } from '../src/app.ts';

const app = new App();
// 環境ごとの非秘密設定(SES 送信元、Okta issuer など)は infra/.env.<env> に置ける。
const envFile = path.join(INFRA_ROOT, `.env.${String(app.node.tryGetContext('env') ?? 'stg')}`);
if (existsSync(envFile)) process.loadEnvFile(envFile);
buildApp(app);
