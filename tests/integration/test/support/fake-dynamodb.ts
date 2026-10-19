import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type {
  BatchGetCommandInput, BatchWriteCommandInput, DeleteCommandInput, GetCommandInput, PutCommandInput, QueryCommandInput,
  ScanCommandInput, TransactWriteCommandInput, UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown>;
type Names = Record<string, string> | undefined;
type Values = Record<string, unknown> | undefined;

/** DynamoDB の予約語のうち、このアプリの属性名になり得るもの(#name で回避しないと ValidationException)。 */
const RESERVED = new Set(['ORDER', 'STATUS', 'TTL', 'NAME', 'COMMENT', 'SIZE', 'DATA', 'KEY', 'VALUE', 'TIMESTAMP', 'USER', 'DATE', 'TIME', 'TYPE', 'COUNT', 'SESSION', 'ROLE', 'PATH', 'DOMAIN']);

const validation = (message: string) => Object.assign(new Error(message), { name: 'ValidationException' });

/** リクエスト内の式が参照する #name / :value を検証し、未使用があれば DynamoDB と同じく拒否する。 */
class Expressions {
  private readonly usedNames = new Set<string>();
  private readonly usedValues = new Set<string>();
  constructor(private readonly names: Names, private readonly values: Values, expressions: (string | undefined)[]) {
    // 本物は式を静的に検証する(OR の短絡評価に関係なく、参照の欠落と未使用を拒否する)。
    for (const token of expressions.join(' ').match(/[#:]\w+/gu) ?? []) {
      if (token.startsWith('#')) this.name(token);
      else this.value(token);
    }
    this.assertAllUsed();
  }

  name(token: string): string {
    if (token.startsWith('#')) {
      const resolved = this.names?.[token];
      if (resolved === undefined) throw validation(`ExpressionAttributeNames に ${token} がありません`);
      this.usedNames.add(token);
      return resolved;
    }
    if (RESERVED.has(token.toUpperCase())) throw validation(`予約語 ${token} を属性名に直接使っています`);
    return token;
  }

  value(token: string): unknown {
    if (!this.values || !(token in this.values)) throw validation(`ExpressionAttributeValues に ${token} がありません`);
    this.usedValues.add(token);
    return this.values[token];
  }

  private assertAllUsed(): void {
    const unusedNames = Object.keys(this.names ?? {}).filter((key) => !this.usedNames.has(key));
    const unusedValues = Object.keys(this.values ?? {}).filter((key) => !this.usedValues.has(key));
    if (unusedNames.length || unusedValues.length) throw validation(`未使用の式属性: ${[...unusedNames, ...unusedValues].join(', ')}`);
    if (this.values && Object.keys(this.values).length === 0) throw validation('ExpressionAttributeValues が空です');
  }

  /** このアプリが使う形(AND/OR、比較、attribute_(not_)exists、begins_with)だけを評価する。 */
  condition(expression: string, item: Item | undefined): boolean {
    return expression.split(/\s+OR\s+/u).some((clause) => clause.split(/\s+AND\s+/u).every((term) => this.term(term.trim(), item)));
  }

  private term(term: string, item: Item | undefined): boolean {
    let match = /^attribute_exists\(([#\w]+)\)$/u.exec(term);
    if (match) return item !== undefined && this.name(match[1]!) in item;
    match = /^attribute_not_exists\(([#\w]+)\)$/u.exec(term);
    if (match) return item === undefined || !(this.name(match[1]!) in item);
    match = /^begins_with\(([#\w]+),\s*(:\w+)\)$/u.exec(term);
    if (match) {
      const actual = item?.[this.name(match[1]!)];
      const prefix = this.value(match[2]!);
      return typeof actual === 'string' && typeof prefix === 'string' && actual.startsWith(prefix);
    }
    match = /^([#\w]+)\s*(=|<>|<=|>=|<|>)\s*(:\w+)$/u.exec(term);
    if (match) return compare(item?.[this.name(match[1]!)], match[2]!, this.value(match[3]!));
    throw validation(`フェイクが未対応の式です: ${term}`);
  }
}

function compare(actual: unknown, operator: string, expected: unknown): boolean {
  if (actual === undefined) return false;
  if (operator === '=') return JSON.stringify(actual) === JSON.stringify(expected);
  if (operator === '<>') return JSON.stringify(actual) !== JSON.stringify(expected);
  // 型が異なる比較は DynamoDB では偽になる。
  if (typeof actual !== typeof expected || (typeof actual !== 'number' && typeof actual !== 'string')) return false;
  const a = actual as number | string;
  const b = expected as number | string;
  if (operator === '<') return a < b;
  if (operator === '<=') return a <= b;
  if (operator === '>') return a > b;
  return a >= b;
}

/** ReturnValues(このフェイクは NONE / ALL_OLD / ALL_NEW のみ。操作ごとに許される値は本物に合わせる)。 */
function returnValues(mode: string | undefined, before: Item | undefined, after: Item | undefined, allowed: string[]) {
  if (mode !== undefined && !allowed.includes(mode)) throw validation(`ReturnValues ${mode} はこの操作では使えないか、フェイクが未対応です`);
  const item = mode === 'ALL_OLD' ? before : mode === 'ALL_NEW' ? after : undefined;
  return item ? { Attributes: structuredClone(item) } : {};
}

const keyOf = (key: Record<string, unknown> | undefined): string => {
  if (typeof key?.PK !== 'string' || typeof key.SK !== 'string') throw validation('キーは PK/SK(String) が必須です');
  return `${key.PK}\u0000${key.SK}`;
};

/**
 * 単一テーブル(PK/SK)のインメモリ実装。条件付き書き込みは ConditionalCheckFailedException を投げ、
 * Scan はページ単位(既定10件)で LastEvaluatedKey を返し、フィルタはページ取得後に適用する(本物と同じ)。
 */
export class FakeDynamoDB {
  readonly items = new Map<string, Item>();
  constructor(
    private readonly tableName: string,
    private readonly indexes: Record<string, { partitionKey: string; sortKey: string }> = {},
    private readonly pageSize = 10,
  ) {}

  private table(name: string | undefined) {
    if (name !== this.tableName) throw Object.assign(new Error(`テーブル ${String(name)} はありません`), { name: 'ResourceNotFoundException' });
  }

  private check(expression: string | undefined, item: Item | undefined, exprs: Expressions) {
    if (expression && !exprs.condition(expression, item)) {
      throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
    }
  }

  get(input: GetCommandInput) {
    this.table(input.TableName);
    const item = this.items.get(keyOf(input.Key));
    return item ? { Item: structuredClone(item) } : {};
  }

  put(input: PutCommandInput) {
    this.table(input.TableName);
    const key = keyOf(input.Item);
    const exprs = new Expressions(input.ExpressionAttributeNames, input.ExpressionAttributeValues, [input.ConditionExpression]);
    const previous = this.items.get(key);
    this.check(input.ConditionExpression, previous, exprs);
    this.items.set(key, structuredClone(input.Item as Item));
    return returnValues(input.ReturnValues, previous, undefined, ['NONE', 'ALL_OLD']);
  }

  update(input: UpdateCommandInput) {
    this.table(input.TableName);
    const key = keyOf(input.Key);
    const exprs = new Expressions(input.ExpressionAttributeNames, input.ExpressionAttributeValues, [input.ConditionExpression, input.UpdateExpression]);
    const current = this.items.get(key);
    this.check(input.ConditionExpression, current, exprs);
    const clauses = [...(input.UpdateExpression ?? '').matchAll(/(SET|REMOVE)\s+((?:(?!\b(?:SET|REMOVE)\b).)+)/gsu)];
    if (clauses.length === 0) throw validation(`フェイクが未対応の更新式です: ${String(input.UpdateExpression)}`);
    const next: Item = structuredClone(current ?? { ...input.Key });
    for (const [, action, body] of clauses) {
      for (const assignment of body!.split(/,(?![^(]*\))/u)) {
        if (action === 'REMOVE') {
          delete next[exprs.name(assignment.trim())];
          continue;
        }
        const parts = /^\s*([#\w]+)\s*=\s*(?:(:\w+)|if_not_exists\(\s*([#\w]+)\s*,\s*(:\w+)\s*\))\s*$/u.exec(assignment);
        if (!parts) throw validation(`フェイクが未対応の SET 句です: ${assignment}`);
        const target = exprs.name(parts[1]!);
        if (parts[2]) next[target] = structuredClone(exprs.value(parts[2]));
        else {
          const existing = current?.[exprs.name(parts[3]!)];
          next[target] = existing === undefined ? structuredClone(exprs.value(parts[4]!)) : existing;
        }
      }
    }
    this.items.set(key, next);
    return returnValues(input.ReturnValues, current, next, ['NONE', 'ALL_OLD', 'ALL_NEW']);
  }

  delete(input: DeleteCommandInput) {
    this.table(input.TableName);
    const key = keyOf(input.Key);
    const exprs = new Expressions(input.ExpressionAttributeNames, input.ExpressionAttributeValues, [input.ConditionExpression]);
    const previous = this.items.get(key);
    this.check(input.ConditionExpression, previous, exprs);
    this.items.delete(key);
    return returnValues(input.ReturnValues, previous, undefined, ['NONE', 'ALL_OLD']);
  }

  scan(input: ScanCommandInput) {
    this.table(input.TableName);
    const keys = [...this.items.keys()].sort();
    const start = input.ExclusiveStartKey ? keys.indexOf(keyOf(input.ExclusiveStartKey)) + 1 : 0;
    const page = keys.slice(start, start + this.pageSize);
    const exprs = new Expressions(input.ExpressionAttributeNames, input.ExpressionAttributeValues, [input.FilterExpression]);
    const Items = page.map((key) => this.items.get(key)!).filter((item) => !input.FilterExpression || exprs.condition(input.FilterExpression, item));
    const last = start + this.pageSize < keys.length ? this.items.get(page.at(-1)!) : undefined;
    return { Items: structuredClone(Items), ...(last ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK } } : {}) };
  }

  /** Query(パーティションキー = :v [AND ソートキー条件])。GSI はスパース(キー属性を持つ項目だけ)で、強い整合性読み込みは不可。 */
  query(input: QueryCommandInput) {
    this.table(input.TableName);
    const index = input.IndexName ? this.indexes[input.IndexName] : { partitionKey: 'PK', sortKey: 'SK' };
    if (!index) throw validation(`インデックス ${String(input.IndexName)} はテーブルにありません`);
    if (input.IndexName && input.ConsistentRead) throw validation('Consistent reads are not supported on global secondary indexes');
    const exprs = new Expressions(input.ExpressionAttributeNames, input.ExpressionAttributeValues, [input.KeyConditionExpression, input.FilterExpression]);
    const key = /^\s*([#\w]+)\s*=\s*(:\w+)\s*(?:AND\s+(.+))?$/su.exec(input.KeyConditionExpression ?? '');
    if (!key || exprs.name(key[1]!) !== index.partitionKey) throw validation(`キー条件がパーティションキー ${index.partitionKey} を指定していません: ${String(input.KeyConditionExpression)}`);
    const sortCondition = key[3];
    const sortAttribute = sortCondition ? /([#\w]+)\s*(?:,|=|<|>|BETWEEN)/u.exec(sortCondition.replace(/^begins_with\(/u, ''))?.[1] : undefined;
    if (sortAttribute && exprs.name(sortAttribute) !== index.sortKey) throw validation(`キー条件のソートキーが ${index.sortKey} ではありません`);
    const pk = exprs.value(key[2]!);
    let matched = [...this.items.values()]
      .filter((item) => item[index.partitionKey] === pk && item[index.sortKey] !== undefined && (!sortCondition || exprs.condition(sortCondition, item)))
      .sort((a, b) => String(a[index.sortKey]).localeCompare(String(b[index.sortKey])) || keyOf(a).localeCompare(keyOf(b)));
    if (input.ScanIndexForward === false) matched = matched.reverse();
    const start = input.ExclusiveStartKey ? matched.findIndex((item) => keyOf(item) === keyOf(input.ExclusiveStartKey)) + 1 : 0;
    const size = Math.min(input.Limit ?? this.pageSize, this.pageSize);
    const page = matched.slice(start, start + size);
    const last = start + size < matched.length ? page.at(-1) : undefined;
    const Items = page.filter((item) => !input.FilterExpression || exprs.condition(input.FilterExpression, item));
    const lastKey = last ? { PK: last.PK, SK: last.SK, [index.partitionKey]: last[index.partitionKey], [index.sortKey]: last[index.sortKey] } : undefined;
    return { Items: structuredClone(Items), Count: Items.length, ...(lastKey ? { LastEvaluatedKey: lastKey } : {}) };
  }

  batchGet(input: BatchGetCommandInput) {
    const Responses: Record<string, Item[]> = {};
    const requested = Object.values(input.RequestItems ?? {}).reduce((sum, request) => sum + (request.Keys?.length ?? 0), 0);
    if (requested > 100) throw validation('BatchGetItem は100件まで');
    for (const [tableName, request] of Object.entries(input.RequestItems ?? {})) {
      this.table(tableName);
      Responses[tableName] = (request.Keys ?? []).flatMap((key) => this.items.has(keyOf(key)) ? [structuredClone(this.items.get(keyOf(key))!)] : []);
    }
    return { Responses, UnprocessedKeys: {} };
  }

  batchWrite(input: BatchWriteCommandInput) {
    const requests = Object.entries(input.RequestItems ?? {});
    if (requests.reduce((sum, [, items]) => sum + items.length, 0) > 25) throw validation('BatchWriteItem は25件まで');
    for (const [TableName, items] of requests) {
      for (const request of items) {
        if (request.PutRequest) this.put({ TableName, Item: request.PutRequest.Item });
        else if (request.DeleteRequest) this.delete({ TableName, Key: request.DeleteRequest.Key });
      }
    }
    return { UnprocessedItems: {} };
  }

  /** すべての条件を先に評価し、1つでも失敗したら何も書かない(TransactionCanceledException)。 */
  transactWrite(input: TransactWriteCommandInput) {
    const items = input.TransactItems ?? [];
    if (items.length > 100) throw validation('TransactWriteItems は100件まで');
    const snapshot = new Map(this.items);
    const reasons: { Code: string }[] = [];
    for (const item of items) {
      try {
        if (item.Put) this.put(item.Put);
        else if (item.Update) this.update(item.Update as UpdateCommandInput);
        else if (item.Delete) this.delete(item.Delete);
        else if (item.ConditionCheck) {
          const check = item.ConditionCheck;
          this.table(check.TableName);
          const exprs = new Expressions(check.ExpressionAttributeNames, check.ExpressionAttributeValues, [check.ConditionExpression]);
          this.check(check.ConditionExpression, this.items.get(keyOf(check.Key)), exprs);
        }
        reasons.push({ Code: 'None' });
      } catch (error) {
        reasons.push({ Code: (error as { name?: string }).name === 'ConditionalCheckFailedException' ? 'ConditionalCheckFailed' : 'ValidationError' });
      }
    }
    if (reasons.some((reason) => reason.Code !== 'None')) {
      this.items.clear();
      for (const [key, value] of snapshot) this.items.set(key, value);
      throw new TransactionCanceledException({ message: 'Transaction cancelled', $metadata: {}, CancellationReasons: reasons });
    }
    return {};
  }

  /** 指定プレフィックスの PK を持つ項目(テストの検証用)。 */
  byPrefix(prefix: string): Item[] {
    return [...this.items.values()].filter((item) => String(item.PK).startsWith(prefix)).map((item) => structuredClone(item));
  }
}
