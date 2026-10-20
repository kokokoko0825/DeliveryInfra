import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { IVSRealTimeClient, ListStorageConfigurationsCommand } from '@aws-sdk/client-ivs-realtime';
import { IvschatClient, ListRoomsCommand } from '@aws-sdk/client-ivschat';
import { resetResourceArnCache, resolveChatRoomArn, resolveStorageConfigurationArn } from './resources';

const chatClient = new IvschatClient({ region: 'ap-northeast-1' });
const ivsClient = new IVSRealTimeClient({ region: 'ap-northeast-1' });
const chat = mockClient(chatClient);
const ivs = mockClient(ivsClient);

beforeEach(() => {
  chat.reset(); ivs.reset();
  resetResourceArnCache();
});

describe('resolveChatRoomArn', () => {
  it('名前で絞り込み、完全一致する1件の ARN を返す', async () => {
    chat.on(ListRoomsCommand).resolves({ rooms: [{ name: 'delivery-stg-room-old', arn: 'arn:old' }, { name: 'delivery-stg-room', arn: 'arn:room' }] });
    await expect(resolveChatRoomArn(chatClient, 'delivery-stg-room')).resolves.toBe('arn:room');
    expect(chat.commandCalls(ListRoomsCommand).map((call) => call.args[0].input)).toEqual([{ name: 'delivery-stg-room' }]);
  });

  it('ページングして全ページから探す', async () => {
    chat.on(ListRoomsCommand, { name: 'room' }).resolves({ rooms: [{ name: 'room-2', arn: 'arn:2' }], nextToken: 'p2' })
      .on(ListRoomsCommand, { name: 'room', nextToken: 'p2' }).resolves({ rooms: [{ name: 'room', arn: 'arn:room' }] });
    await expect(resolveChatRoomArn(chatClient, 'room')).resolves.toBe('arn:room');
    expect(chat.commandCalls(ListRoomsCommand)).toHaveLength(2);
  });

  it('0件は ResourceNotFoundException、複数件はエラー', async () => {
    chat.on(ListRoomsCommand).resolves({ rooms: [] });
    await expect(resolveChatRoomArn(chatClient, 'room')).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
    chat.on(ListRoomsCommand).resolves({});
    await expect(resolveChatRoomArn(chatClient, 'room')).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
    chat.on(ListRoomsCommand).resolves({ rooms: [{ name: 'room', arn: 'arn:1' }, { name: 'room', arn: 'arn:2' }] });
    await expect(resolveChatRoomArn(chatClient, 'room')).rejects.toThrow('Chat Room "room" が 2 件あります');
    chat.on(ListRoomsCommand).resolves({ rooms: [{ name: 'room' }] });
    await expect(resolveChatRoomArn(chatClient, 'room')).rejects.toThrow('Chat Room "room" の ARN がありません');
  });

  it('成功した結果はキャッシュし、失敗はキャッシュしない', async () => {
    chat.on(ListRoomsCommand).rejectsOnce(new Error('throttled')).resolves({ rooms: [{ name: 'room', arn: 'arn:room' }] });
    await expect(resolveChatRoomArn(chatClient, 'room')).rejects.toThrow('throttled');
    await expect(resolveChatRoomArn(chatClient, 'room')).resolves.toBe('arn:room');
    await expect(resolveChatRoomArn(chatClient, 'room')).resolves.toBe('arn:room');
    expect(chat.commandCalls(ListRoomsCommand)).toHaveLength(2);
    resetResourceArnCache();
    await expect(resolveChatRoomArn(chatClient, 'room')).resolves.toBe('arn:room');
    expect(chat.commandCalls(ListRoomsCommand)).toHaveLength(3);
  });

  it('同時の初回呼び出しは1回の解決を共有する', async () => {
    chat.on(ListRoomsCommand).resolves({ rooms: [{ name: 'room', arn: 'arn:room' }] });
    await expect(Promise.all([resolveChatRoomArn(chatClient, 'room'), resolveChatRoomArn(chatClient, 'room')])).resolves.toEqual(['arn:room', 'arn:room']);
    expect(chat.commandCalls(ListRoomsCommand)).toHaveLength(1);
  });
});

describe('resolveStorageConfigurationArn', () => {
  it('ページングして名前が完全一致する1件の ARN を返す', async () => {
    ivs.on(ListStorageConfigurationsCommand, {}).resolves({ storageConfigurations: [{ name: 'other', arn: 'arn:other' }], nextToken: 'p2' })
      .on(ListStorageConfigurationsCommand, { nextToken: 'p2' }).resolves({ storageConfigurations: [{ name: 'delivery-stg-recording', arn: 'arn:storage' }] });
    await expect(resolveStorageConfigurationArn(ivsClient, 'delivery-stg-recording')).resolves.toBe('arn:storage');
    expect(ivs.commandCalls(ListStorageConfigurationsCommand).map((call) => call.args[0].input)).toEqual([{}, { nextToken: 'p2' }]);
  });

  it('0件は ResourceNotFoundException、複数件はエラー', async () => {
    ivs.on(ListStorageConfigurationsCommand).resolves({ storageConfigurations: [{ name: 'other', arn: 'arn:other' }] });
    await expect(resolveStorageConfigurationArn(ivsClient, 'recording')).rejects.toMatchObject({ name: 'ResourceNotFoundException', message: 'StorageConfiguration "recording" が見つかりません' });
    ivs.on(ListStorageConfigurationsCommand).resolves({ storageConfigurations: undefined });
    await expect(resolveStorageConfigurationArn(ivsClient, 'recording')).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
    ivs.on(ListStorageConfigurationsCommand).resolves({ storageConfigurations: [{ name: 'recording', arn: 'arn:1' }, { name: 'recording', arn: 'arn:2' }] });
    await expect(resolveStorageConfigurationArn(ivsClient, 'recording')).rejects.toThrow('StorageConfiguration "recording" が 2 件あります');
  });

  it('キャッシュは種類と名前ごとに分かれる', async () => {
    ivs.on(ListStorageConfigurationsCommand).resolves({ storageConfigurations: [{ name: 'a', arn: 'arn:a' }, { name: 'b', arn: 'arn:b' }] });
    chat.on(ListRoomsCommand).resolves({ rooms: [{ name: 'a', arn: 'arn:room-a' }] });
    await expect(resolveStorageConfigurationArn(ivsClient, 'a')).resolves.toBe('arn:a');
    await expect(resolveStorageConfigurationArn(ivsClient, 'b')).resolves.toBe('arn:b');
    await expect(resolveChatRoomArn(chatClient, 'a')).resolves.toBe('arn:room-a');
    await expect(resolveStorageConfigurationArn(ivsClient, 'a')).resolves.toBe('arn:a');
    expect(ivs.commandCalls(ListStorageConfigurationsCommand)).toHaveLength(2);
  });
});
