/**
 * SQLite 查询拼接（WHERE / ORDER BY / LIMIT）
 * 参考: specs/tech/persistence/[P0]sqlite_crud_store_engine.md §4（query 映射）
 *
 * 设计：契约 QueryFilter 的所有维度都映射到信封列（spec §3.2 业务字段不进契约）。
 *   - ids / createdAfter / createdBefore → WHERE
 *   - order → ORDER BY created_at
 *   - limit → LIMIT
 *   - shardKey：SQLite 不分片，spec §4 明确「全走信封列，shardKey 当普通索引列，
 *     不分片」—— 故本 engine 忽略 filter.shardKey（不分片 entity）
 *
 * 参数化绑定：所有值走 `?` 占位符，禁止字符串拼接防注入。
 */
import type { QueryFilter, QueryOrder } from './crud-types';
import { ENV_CREATED_AT } from './sqlite-schema';

/** query 拼接结果：sql 片段（无 SELECT/FROM，仅 WHERE/ORDER/LIMIT）+ 绑定参数 */
export interface BuiltQuery {
  /** WHERE 子句（含 'WHERE' 前缀，或空串） */
  whereSql: string;
  /** ORDER BY + LIMIT 子句 */
  tailSql: string;
  /** 按顺序对应的绑定参数 */
  params: unknown[];
}

const ORDER_BY: Record<QueryOrder, string> = {
  createdAtAsc: `${ENV_CREATED_AT} ASC`,
  createdAtDesc: `${ENV_CREATED_AT} DESC`,
};

/**
 * 把 QueryFilter 拼成 WHERE/ORDER/LIMIT 片段（值参数化）。
 * @param filter 查询过滤；order 缺省 createdAtDesc，limit 缺省无上限
 */
export function buildQuery(filter: QueryFilter): BuiltQuery {
  const where: string[] = [];
  const params: unknown[] = [];

  // ids → id IN (?, ?, ...)
  if (filter.ids && filter.ids.length > 0) {
    const placeholders = filter.ids.map(() => '?').join(', ');
    where.push(`id IN (${placeholders})`);
    params.push(...filter.ids);
  }

  // createdAfter（含）→ created_at >= ?
  if (filter.createdAfter !== undefined) {
    where.push(`${ENV_CREATED_AT} >= ?`);
    params.push(filter.createdAfter);
  }

  // createdBefore（不含）→ created_at < ?
  if (filter.createdBefore !== undefined) {
    where.push(`${ENV_CREATED_AT} < ?`);
    params.push(filter.createdBefore);
  }

  // shardKey 被 SQLite engine 忽略（不分片，spec §4）
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // ORDER BY（缺省 createdAtDesc）
  const order: QueryOrder = filter.order ?? 'createdAtDesc';
  let tailSql = `ORDER BY ${ORDER_BY[order]}`;

  // LIMIT
  if (filter.limit !== undefined) {
    tailSql += ' LIMIT ?';
    params.push(filter.limit);
  }

  return { whereSql, tailSql, params };
}

/**
 * 构建 json_extract 扩展查询的 WHERE 片段（engine 专有，不跨 engine 可移植）。
 *
 * ⚠️ engine 专有扩展（spec §4 末段）：业务字段过滤走 json_extract(data,'$.field')，
 *    这不是 CrudStore 契约保证的查询维度，FS engine 无此能力，调用方自负。
 *    SqliteCrudStore.queryByJsonExtract 用本函数拼 WHERE。
 *
 * 参数顺序：value 先于契约维度参数，limit 最后（与 SQL 占位符顺序一致）。
 *
 * @param field data blob 内的字段名（仅字母数字下划线，白名单防注入）
 * @param value 要匹配的值
 * @param filter 可选契约维度（ids/createdAfter/Before/order/limit）叠加
 */
export function buildJsonExtractWhere(
  field: string,
  value: unknown,
  filter?: QueryFilter,
): BuiltQuery {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
    throw new Error(`非法 json_extract 字段名: ${field}`);
  }
  const where: string[] = [`json_extract(data, '$.${field}') = ?`];
  // value 必须是第一个参数（对应第一个占位符）
  const params: unknown[] = [value];

  // 叠加契约维度（不含 limit，limit 留到最后单独加）
  if (filter) {
    if (filter.ids && filter.ids.length > 0) {
      const placeholders = filter.ids.map(() => '?').join(', ');
      where.push(`id IN (${placeholders})`);
      params.push(...filter.ids);
    }
    if (filter.createdAfter !== undefined) {
      where.push(`${ENV_CREATED_AT} >= ?`);
      params.push(filter.createdAfter);
    }
    if (filter.createdBefore !== undefined) {
      where.push(`${ENV_CREATED_AT} < ?`);
      params.push(filter.createdBefore);
    }
  }

  const order: QueryOrder = filter?.order ?? 'createdAtDesc';
  let tailSql = `ORDER BY ${ORDER_BY[order]}`;
  if (filter?.limit !== undefined) {
    tailSql += ' LIMIT ?';
    params.push(filter.limit); // limit 永远在参数末尾
  }

  return { whereSql: `WHERE ${where.join(' AND ')}`, tailSql, params };
}
