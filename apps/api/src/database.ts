import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface Entity { PK: string; SK: string; [key: string]: unknown }

/** 単一テーブルのキー。GSI は使わず、一覧は固定 PK の Query で読む（docs/20261019-api-design.md）。 */
export const KEYS = {
  user: (id: string) => `USER#${id}`,
  devicePk: 'DEVICE',
  deviceSk: (purpose: string, slot: number) => `${purpose}#${slot}`,
  /** コメント本体は PK=COMMENT / SK=<sentAt>#<messageId>（時刻順 Query）。messageId からは参照行で SK を引く。 */
  commentPk: 'COMMENT',
  commentSk: (sentAt: string, id: string) => `${sentAt}#${id}`,
  commentRef: (id: string) => `COMMENT#${id}`,
  slidePk: 'SLIDE',
  archivePk: 'ARCHIVE',
  ngWordPk: 'NGWORD',
  compositionPk: (arn: string) => `COMPOSITION#${arn}`,
} as const;

export interface QueryOptions {
  skPrefix?: string;
  descending?: boolean;
  consistentRead?: boolean;
  filter?: { expression: string; values: Record<string, unknown>; names?: Record<string, string> };
  /** 条件に合う件数がこの数に達したら止める。 */
  limit?: number;
}

export const isConditionalFailure = (error: unknown) => (error as { name?: string }).name === 'ConditionalCheckFailedException';

export class Database {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly tableName: string) {}
  async get<T extends Entity>(PK: string, SK: string, consistentRead = false): Promise<T | undefined> {
    const result = await this.ddb.send(new GetCommand({ TableName: this.tableName, Key: { PK, SK }, ...(consistentRead ? { ConsistentRead: true } : {}) }));
    return result.Item as T | undefined;
  }
  async put(item: Entity, conditionExpression?: string, expressionValues?: Record<string, unknown>, expressionNames?: Record<string, string>): Promise<void> {
    await this.ddb.send(new PutCommand({
      TableName: this.tableName, Item: item,
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
      ...(expressionValues ? { ExpressionAttributeValues: expressionValues } : {}),
      ...(expressionNames ? { ExpressionAttributeNames: expressionNames } : {}),
    }));
  }
  async update(PK: string, SK: string, UpdateExpression: string, ExpressionAttributeValues: Record<string, unknown>, ConditionExpression?: string, ExpressionAttributeNames?: Record<string, string>): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: this.tableName, Key: { PK, SK }, UpdateExpression, ExpressionAttributeValues,
      ...(ConditionExpression ? { ConditionExpression } : {}),
      ...(ExpressionAttributeNames ? { ExpressionAttributeNames } : {}),
    }));
  }
  async delete(PK: string, SK: string, ConditionExpression?: string, ExpressionAttributeValues?: Record<string, unknown>): Promise<void> {
    await this.ddb.send(new DeleteCommand({
      TableName: this.tableName, Key: { PK, SK },
      ...(ConditionExpression ? { ConditionExpression } : {}),
      ...(ExpressionAttributeValues ? { ExpressionAttributeValues } : {}),
    }));
  }
  async query<T extends Entity>(pk: string, options: QueryOptions = {}): Promise<T[]> {
    const Items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.ddb.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: options.skPrefix ? '#pk = :pk AND begins_with(#sk, :sk)' : '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'PK', ...(options.skPrefix ? { '#sk': 'SK' } : {}), ...options.filter?.names },
        ExpressionAttributeValues: { ':pk': pk, ...(options.skPrefix ? { ':sk': options.skPrefix } : {}), ...options.filter?.values },
        ...(options.filter ? { FilterExpression: options.filter.expression } : {}),
        ...(options.descending ? { ScanIndexForward: false } : {}),
        ...(options.consistentRead ? { ConsistentRead: true } : {}),
        ...(options.limit ? { Limit: options.limit } : {}),
        ExclusiveStartKey,
      }));
      Items.push(...(page.Items as T[] | undefined ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey && (options.limit === undefined || Items.length < options.limit));
    return options.limit === undefined ? Items : Items.slice(0, options.limit);
  }
}

export const makeDatabase = (ddb: DynamoDBDocumentClient, env: { TABLE_NAME: string }) => new Database(ddb, env.TABLE_NAME);
