import { DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Env } from './env';

export interface Entity { PK: string; SK: string; [key: string]: unknown }
export class Database {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly tableName: string) {}
  async get<T extends Entity>(PK: string, SK: string): Promise<T | undefined> {
    const result = await this.ddb.send(new GetCommand({ TableName: this.tableName, Key: { PK, SK } }));
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
  async scan<T extends Entity>(FilterExpression?: string, ExpressionAttributeValues?: Record<string, unknown>): Promise<T[]> {
    const Items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.ddb.send(new ScanCommand({ TableName: this.tableName, FilterExpression, ExpressionAttributeValues, ExclusiveStartKey }));
      Items.push(...(page.Items as T[] | undefined ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return Items;
  }
}

export const makeDatabase = (ddb: DynamoDBDocumentClient, env: Env) => new Database(ddb, env.TABLE_NAME);
