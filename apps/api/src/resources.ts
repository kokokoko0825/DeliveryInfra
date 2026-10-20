import { ListStorageConfigurationsCommand, type IVSRealTimeClient } from '@aws-sdk/client-ivs-realtime';
import { ListRoomsCommand, type IvschatClient } from '@aws-sdk/client-ivschat';

/**
 * Chat Room と録画 StorageConfiguration の ARN を名前から引く。
 * API Lambda が ARN を CloudFormation で参照すると、バケットポリシー → Distribution → API 関数URL と循環するため、
 * 環境変数には固定名だけを渡し、初回利用時に List API で解決してモジュールスコープでキャッシュする。
 * 0件・複数件は設定不備なのでエラーにする(0件は ResourceNotFoundException として扱えるようにする)。
 */
const cache = new Map<string, Promise<string>>();

const notFound = (kind: string, name: string) => Object.assign(new Error(`${kind} "${name}" が見つかりません`), { name: 'ResourceNotFoundException' });

function single(kind: string, name: string, arns: (string | undefined)[]): string {
  if (arns.length === 0) throw notFound(kind, name);
  if (arns.length > 1) throw new Error(`${kind} "${name}" が ${arns.length} 件あります`);
  const [arn] = arns;
  if (!arn) throw new Error(`${kind} "${name}" の ARN がありません`);
  return arn;
}

function cached(key: string, resolve: () => Promise<string>): Promise<string> {
  let value = cache.get(key);
  if (!value) {
    value = resolve();
    cache.set(key, value);
    // 失敗(一時障害・作成前)はキャッシュせず、次の呼び出しで引き直す。
    value.catch(() => cache.delete(key));
  }
  return value;
}

export function resolveChatRoomArn(chat: IvschatClient, name: string): Promise<string> {
  return cached(`room:${name}`, async () => {
    const arns: (string | undefined)[] = [];
    let nextToken: string | undefined;
    do {
      const page = await chat.send(new ListRoomsCommand({ name, ...(nextToken ? { nextToken } : {}) }));
      // name は部分一致のフィルタなので完全一致だけを残す。
      arns.push(...(page.rooms ?? []).filter((room) => room.name === name).map((room) => room.arn));
      nextToken = page.nextToken;
    } while (nextToken);
    return single('Chat Room', name, arns);
  });
}

export function resolveStorageConfigurationArn(ivs: IVSRealTimeClient, name: string): Promise<string> {
  return cached(`storage:${name}`, async () => {
    const arns: (string | undefined)[] = [];
    let nextToken: string | undefined;
    do {
      const page = await ivs.send(new ListStorageConfigurationsCommand(nextToken ? { nextToken } : {}));
      arns.push(...(page.storageConfigurations ?? []).filter((storage) => storage.name === name).map((storage) => storage.arn));
      nextToken = page.nextToken;
    } while (nextToken);
    return single('StorageConfiguration', name, arns);
  });
}

export function resetResourceArnCache(): void { cache.clear(); }
